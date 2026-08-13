const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { sendMail, welcomeEmail, confirmEmail, mailConfig } = require('./mail');

const app = express();
app.set('trust proxy', true);

const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || 'https://tiagoo.vercel.app,http://localhost:4000,http://127.0.0.1:4000')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    if (!origin || ALLOWED_ORIGINS.includes(origin) || /\.vercel\.app$/.test(origin || '')) return cb(null, true);
    return cb(null, false);
  }
}));
app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, '../frontend')));

const IS_SERVERLESS = !!process.env.VERCEL || !!process.env.AWS_LAMBDA_FUNCTION_NAME;
const DATA_DIR = IS_SERVERLESS ? '/tmp' : __dirname;
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOAD_DIR));

const DB_FILE = path.join(DATA_DIR, 'db.json');
if (!fs.existsSync(DB_FILE)) {
  const seedCandidates = [path.join(__dirname, 'db.json'), path.join(__dirname, 'db.sample.json')];
  const seed = seedCandidates.find(p => p !== DB_FILE && fs.existsSync(p));
  if (seed) {
    try { fs.copyFileSync(seed, DB_FILE); } catch (e) { console.warn('Could not seed db.json:', e.message); }
  }
}

let usingMongo = false;
let mongoModels = null;
let db = emptyDb();

function emptyDb() {
  return {
    menus: [],
    orders: [],
    users: [],
    inventories: [],
    cash: [],
    lastMenuId: 0,
    lastOrderId: 0,
    lastUserId: 0,
    lastInventoryId: 0,
    lastCashId: 0
  };
}

function mapMongoToDb(users, menus, orders, inventories, cash) {
  const mapped = {
    menus: (menus || []).map(m => ({
      id: m.legacyId || 0,
      ownerId: m.legacyOwnerId || null,
      name: m.name,
      description: m.description || '',
      price: m.price,
      stock: typeof m.stock === 'number' ? m.stock : null,
      category: m.category || '',
      unit: m.unit || '',
      available: m.available,
      image: m.image || null
    })),
    orders: (orders || []).map(o => ({
      id: o.legacyId || 0,
      ownerId: o.legacyOwnerId || null,
      customer_name: o.customer_name,
      customer_phone: o.customer_phone,
      customer_address: o.customer_address || null,
      customer_notes: o.customer_notes || null,
      items: o.items,
      total: o.total,
      status: o.status,
      proof_url: o.proof_url,
      proof_token: o.proof_token || null,
      created_at: o.created_at,
      paid_at: o.paid_at,
      proof_submitted_at: o.proof_submitted_at || null,
      dispatched_at: o.dispatched_at || null,
      delivered_at: o.delivered_at || null,
      cancelled_at: o.cancelled_at || null,
      cancel_reason: o.cancel_reason || '',
      payment_method: o.payment_method || null
    })),
    users: (users || []).map(u => ({
      id: u.legacyId || 0,
      username: u.username,
      salt: u.salt,
      hash: u.hash,
      role: u.role,
      business: u.business,
      email: u.email || '',
      emailVerified: u.emailVerified !== false,
      googleId: u.googleId || null,
      authProvider: u.authProvider || 'local',
      confirmToken: u.confirmToken || null,
      confirmCode: u.confirmCode || null,
      confirmExpires: u.confirmExpires || null
    })),
    inventories: (inventories || []).map(i => ({ id: i.legacyId || 0, ownerId: i.legacyOwnerId || null, name: i.name, qty: i.qty, unit: i.unit })),
    cash: (cash || []).map(c => ({
      id: c.legacyId || 0,
      ownerId: c.legacyOwnerId || null,
      type: c.type,
      amount: c.amount,
      note: c.note,
      orderId: c.orderId || null,
      created_at: c.created_at
    }))
  };
  mapped.lastMenuId = mapped.menus.length ? Math.max(...mapped.menus.map(m => m.id || 0)) : 0;
  mapped.lastOrderId = mapped.orders.length ? Math.max(...mapped.orders.map(o => o.id || 0)) : 0;
  mapped.lastUserId = mapped.users.length ? Math.max(...mapped.users.map(u => u.id || 0)) : 0;
  mapped.lastInventoryId = mapped.inventories.length ? Math.max(...mapped.inventories.map(i => i.id || 0)) : 0;
  mapped.lastCashId = mapped.cash.length ? Math.max(...mapped.cash.map(c => c.id || 0)) : 0;
  return mapped;
}

async function loadDbFromMongo() {
  const users = await mongoModels.User.find({}).lean();
  const menus = await mongoModels.Menu.find({}).lean();
  const orders = await mongoModels.Order.find({}).lean();
  const inventories = await mongoModels.Inventory.find({}).lean();
  const cash = await mongoModels.Cash.find({}).lean();
  return mapMongoToDb(users, menus, orders, inventories, cash);
}

async function initMongoIfConfigured() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGOURL || process.env.MONGOURL_SHORT;
  if (!mongoUri) return null;
  try {
    mongoModels = require('./mongo_models');
    const m = mongoModels.mongoose;
    if (m.connection.readyState !== 1) {
      await m.connect(mongoUri, {
        serverSelectionTimeoutMS: 20000,
        connectTimeoutMS: 20000,
        family: 4, // Force IPv4 — common fix for Atlas + serverless
        maxPoolSize: 5
      });
    }
    usingMongo = true;
    console.log('Connected to MongoDB via MONGO_URI');
    const fromMongo = await loadDbFromMongo();
    try { fs.writeFileSync(DB_FILE, JSON.stringify(fromMongo, null, 2)); } catch (e) { /* ignore */ }
    return fromMongo;
  } catch (e) {
    console.warn('Mongo init failed, falling back to file DB:', e.message);
    usingMongo = false;
    return null;
  }
}

/** Retry Mongo when URI is set but the first cold-start connect failed (Atlas IP / transient). */
async function ensureMongoConnected() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGOURL || process.env.MONGOURL_SHORT;
  if (!mongoUri) return false;
  if (usingMongo && mongoModels && mongoModels.mongoose.connection.readyState === 1) return true;
  const loaded = await initMongoIfConfigured();
  if (loaded) {
    db = loaded;
    return true;
  }
  return false;
}

function readFileDb() {
  const defaultSeed = {
    menus: [
      { id: 1, name: 'Pizza Margarita', price: 25000, available: true },
      { id: 2, name: 'Hamburguesa Clasica', price: 18000, available: true }
    ],
    orders: [],
    users: [],
    inventories: [],
    cash: [],
    lastMenuId: 2,
    lastOrderId: 0,
    lastUserId: 0,
    lastInventoryId: 0,
    lastCashId: 0
  };
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify(defaultSeed, null, 2));
    return defaultSeed;
  }
  try {
    const fileDb = JSON.parse(fs.readFileSync(DB_FILE));
    fileDb.menus = Array.isArray(fileDb.menus) ? fileDb.menus : defaultSeed.menus.slice();
    fileDb.orders = Array.isArray(fileDb.orders) ? fileDb.orders : [];
    fileDb.users = Array.isArray(fileDb.users) ? fileDb.users : [];
    fileDb.inventories = Array.isArray(fileDb.inventories) ? fileDb.inventories : [];
    fileDb.cash = Array.isArray(fileDb.cash) ? fileDb.cash : [];
    fileDb.lastMenuId = Number.isFinite(fileDb.lastMenuId) ? fileDb.lastMenuId : (fileDb.menus.length ? Math.max(...fileDb.menus.map(m => m.id)) : defaultSeed.lastMenuId);
    fileDb.lastOrderId = Number.isFinite(fileDb.lastOrderId) ? fileDb.lastOrderId : (fileDb.orders.length ? Math.max(...fileDb.orders.map(o => o.id)) : 0);
    fileDb.lastUserId = Number.isFinite(fileDb.lastUserId) ? fileDb.lastUserId : (fileDb.users.length ? Math.max(...fileDb.users.map(u => u.id)) : 0);
    fileDb.lastInventoryId = Number.isFinite(fileDb.lastInventoryId) ? fileDb.lastInventoryId : (fileDb.inventories.length ? Math.max(...fileDb.inventories.map(i => i.id)) : 0);
    fileDb.lastCashId = Number.isFinite(fileDb.lastCashId) ? fileDb.lastCashId : (fileDb.cash.length ? Math.max(...fileDb.cash.map(c => c.id)) : 0);
    return fileDb;
  } catch (err) {
    fs.writeFileSync(DB_FILE, JSON.stringify(defaultSeed, null, 2));
    return defaultSeed;
  }
}

function readDB() {
  if (usingMongo) return db;
  return readFileDb();
}

async function writeDB(current) {
  db = current;
  try { fs.writeFileSync(DB_FILE, JSON.stringify(current, null, 2)); } catch (e) { console.warn('write file db failed:', e.message); }
  if (!usingMongo || !mongoModels) return;

  const ops = [];
  for (const u of current.users || []) {
    ops.push(mongoModels.User.updateOne(
      { legacyId: u.id },
      {
        $set: {
          legacyId: u.id,
          username: u.username,
          role: u.role,
          salt: u.salt,
          hash: u.hash,
          business: u.business || null,
          email: u.email || '',
          emailVerified: u.emailVerified !== false,
          googleId: u.googleId || null,
          authProvider: u.authProvider || 'local',
          confirmToken: u.confirmToken || null,
          confirmCode: u.confirmCode || null,
          confirmExpires: u.confirmExpires || null
        }
      },
      { upsert: true }
    ));
  }
  for (const m of current.menus || []) {
    ops.push(mongoModels.Menu.updateOne(
      { legacyId: m.id },
      {
        $set: {
          legacyId: m.id,
          legacyOwnerId: m.ownerId || null,
          name: m.name,
          description: m.description || '',
          price: m.price,
          stock: typeof m.stock === 'number' ? m.stock : null,
          category: m.category || '',
          unit: m.unit || '',
          available: !!m.available,
          image: m.image || null
        }
      },
      { upsert: true }
    ));
  }
  for (const o of current.orders || []) {
    ops.push(mongoModels.Order.updateOne(
      { legacyId: o.id },
      {
        $set: {
          legacyId: o.id,
          legacyOwnerId: o.ownerId || null,
          customer_name: o.customer_name,
          customer_phone: o.customer_phone || null,
          customer_address: o.customer_address || null,
          customer_notes: o.customer_notes || null,
          items: o.items || [],
          total: o.total || 0,
          status: o.status || 'pending',
          proof_url: o.proof_url || null,
          proof_token: o.proof_token || null,
          created_at: o.created_at ? new Date(o.created_at) : new Date(),
          paid_at: o.paid_at ? new Date(o.paid_at) : null,
          proof_submitted_at: o.proof_submitted_at ? new Date(o.proof_submitted_at) : null,
          dispatched_at: o.dispatched_at ? new Date(o.dispatched_at) : null,
          delivered_at: o.delivered_at ? new Date(o.delivered_at) : null,
          cancelled_at: o.cancelled_at ? new Date(o.cancelled_at) : null,
          cancel_reason: o.cancel_reason || '',
          payment_method: o.payment_method || null
        }
      },
      { upsert: true }
    ));
  }
  for (const i of current.inventories || []) {
    ops.push(mongoModels.Inventory.updateOne(
      { legacyId: i.id },
      { $set: { legacyId: i.id, legacyOwnerId: i.ownerId || null, name: i.name, qty: i.qty || 0, unit: i.unit || '' } },
      { upsert: true }
    ));
  }
  for (const c of current.cash || []) {
    ops.push(mongoModels.Cash.updateOne(
      { legacyId: c.id },
      {
        $set: {
          legacyId: c.id,
          legacyOwnerId: c.ownerId || null,
          type: c.type,
          amount: c.amount,
          note: c.note || '',
          orderId: c.orderId || null,
          created_at: c.created_at ? new Date(c.created_at) : new Date()
        }
      },
      { upsert: true }
    ));
  }

  // Note: do not blanket-delete missing menus/inventory here.
  // Explicit DELETE routes remove documents; a full-snapshot $nin wipe is unsafe
  // when another instance has partially loaded state.

  try {
    await Promise.all(ops);
  } catch (e) {
    console.warn('Error syncing to Mongo:', e.message);
    throw e;
  }
}

db = readFileDb();

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  const h = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(hash, 'hex'));
  } catch (e) {
    return false;
  }
}

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || (IS_SERVERLESS ? null : 'admin123');
const SEED_NEGOCIO_USER = process.env.SEED_NEGOCIO_USER || 'santiburgers';
const SEED_NEGOCIO_PASS = process.env.SEED_NEGOCIO_PASS || 'Santi2026!';

async function ensureAdmin() {
  if (!ADMIN_USER || !ADMIN_PASS) return;
  db = readDB();
  const { salt, hash } = hashPassword(ADMIN_PASS);
  let existing = db.users.find(u => u.username === ADMIN_USER);
  const forceReset = process.env.ADMIN_RESET === '1';
  if (!existing) {
    db.users.push({
      id: ++db.lastUserId,
      username: ADMIN_USER,
      salt,
      hash,
      role: 'admin',
      business: { name: 'WhatsMenú Admin', slug: 'admin' }
    });
    await writeDB(db);
    console.log('Admin user created:', ADMIN_USER);
  } else if (forceReset || existing.role !== 'admin') {
    existing.salt = salt;
    existing.hash = hash;
    existing.role = 'admin';
    await writeDB(db);
    console.log('Admin user password/role updated:', ADMIN_USER);
  }
}

async function ensureSeedNegocio() {
  if (!SEED_NEGOCIO_USER || !SEED_NEGOCIO_PASS) return;
  db = readDB();
  const { salt, hash } = hashPassword(SEED_NEGOCIO_PASS);
  let user = db.users.find(u => u.username === SEED_NEGOCIO_USER);
  const forceReset = process.env.SEED_NEGOCIO_RESET === '1';
  if (!user) {
    user = {
      id: ++db.lastUserId,
      username: SEED_NEGOCIO_USER,
      salt,
      hash,
      role: 'negocio',
      business: {
        name: SEED_NEGOCIO_USER,
        email: 'santiburgers@yopmail.com',
        phone: '3022642595',
        address: 'calle 52 B sur 62 A-15',
        store_kind: 'restaurant',
        slug: SEED_NEGOCIO_USER.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'negocio'
      }
    };
    db.users.push(user);
    await writeDB(db);
    console.log('Seed negocio created:', SEED_NEGOCIO_USER);
  } else if (forceReset) {
    user.salt = salt;
    user.hash = hash;
    user.role = 'negocio';
    await writeDB(db);
    console.log('Seed negocio password reset:', SEED_NEGOCIO_USER);
  }
}

async function ensureMercaMono() {
  const USER = process.env.MERCA_USER || 'mercamono';
  const PASS = process.env.MERCA_PASS || 'Merca2026!';
  db = readDB();
  const { salt, hash } = hashPassword(PASS);
  const categories = [
    'Carnicería',
    'Legumbrería',
    'Comestibles',
    'Lácteos',
    'Bebidas',
    'Panadería',
    'Aseo'
  ];
  const seedProducts = [
    { name: 'Carne de res molida', description: 'Paquete fresco 500g', price: 12500, stock: 40, category: 'Carnicería', unit: 'paq' },
    { name: 'Pollo entero', description: 'Pollo fresco aprox 1.2kg', price: 18000, stock: 25, category: 'Carnicería', unit: 'und' },
    { name: 'Costilla de cerdo', description: 'Por kilo', price: 16000, stock: 30, category: 'Carnicería', unit: 'kg' },
    { name: 'Pechuga de pollo', description: 'Filete fresco por kilo', price: 14500, stock: 35, category: 'Carnicería', unit: 'kg' },
    { name: 'Carne de cerdo para guiso', description: 'Cortada en trozos', price: 13200, stock: 28, category: 'Carnicería', unit: 'kg' },
    { name: 'Chorizo antioqueño', description: 'Paquete x4', price: 8900, stock: 40, category: 'Carnicería', unit: 'paq' },
    { name: 'Tomate chonto', description: 'Fresco de la huerta', price: 3500, stock: 80, category: 'Legumbrería', unit: 'lb' },
    { name: 'Cebolla cabezona', description: 'Blanca', price: 2800, stock: 70, category: 'Legumbrería', unit: 'lb' },
    { name: 'Plátano verde', description: 'Unidad', price: 800, stock: 120, category: 'Legumbrería', unit: 'und' },
    { name: 'Papa criolla', description: 'Libra', price: 3200, stock: 90, category: 'Legumbrería', unit: 'lb' },
    { name: 'Zanahoria', description: 'Fresco', price: 2500, stock: 75, category: 'Legumbrería', unit: 'lb' },
    { name: 'Aguacate hass', description: 'Unidad madura', price: 3500, stock: 50, category: 'Legumbrería', unit: 'und' },
    { name: 'Limón tahití', description: 'Libra', price: 2200, stock: 60, category: 'Legumbrería', unit: 'lb' },
    { name: 'Arroz 1kg', description: 'Arroz blanco', price: 4500, stock: 60, category: 'Comestibles', unit: 'paq' },
    { name: 'Aceite 1L', description: 'Aceite vegetal', price: 9800, stock: 45, category: 'Comestibles', unit: 'und' },
    { name: 'Huevos x12', description: 'Cartón de 12', price: 7200, stock: 50, category: 'Comestibles', unit: 'cartón' },
    { name: 'Pasta spaghetti 500g', description: 'Paquete', price: 3900, stock: 55, category: 'Comestibles', unit: 'paq' },
    { name: 'Frijol cargamanto 500g', description: 'Seco', price: 5200, stock: 40, category: 'Comestibles', unit: 'paq' },
    { name: 'Azúcar 1kg', description: 'Blanca', price: 4100, stock: 48, category: 'Comestibles', unit: 'paq' },
    { name: 'Sal refinada 1kg', description: 'Paquete', price: 1800, stock: 70, category: 'Comestibles', unit: 'paq' },
    { name: 'Leche entera 1L', description: 'Bolsa o caja', price: 4200, stock: 55, category: 'Lácteos', unit: 'und' },
    { name: 'Queso campesino', description: 'Bloque aprox 500g', price: 9800, stock: 30, category: 'Lácteos', unit: 'und' },
    { name: 'Yogurt natural', description: 'Vaso 150g', price: 2200, stock: 60, category: 'Lácteos', unit: 'und' },
    { name: 'Mantequilla 250g', description: 'Con sal', price: 6500, stock: 35, category: 'Lácteos', unit: 'und' },
    { name: 'Agua 600ml', description: 'Botella', price: 1500, stock: 100, category: 'Bebidas', unit: 'und' },
    { name: 'Gaseosa 1.5L', description: 'Surtida', price: 4500, stock: 48, category: 'Bebidas', unit: 'und' },
    { name: 'Jugo hit 1L', description: 'Sabor surtido', price: 3800, stock: 40, category: 'Bebidas', unit: 'und' },
    { name: 'Café molido 250g', description: 'Tostado', price: 8900, stock: 32, category: 'Bebidas', unit: 'paq' },
    { name: 'Pan tajado', description: 'Bolsa familiar', price: 5200, stock: 28, category: 'Panadería', unit: 'und' },
    { name: 'Arepa de maíz', description: 'Paquete x5', price: 3500, stock: 40, category: 'Panadería', unit: 'paq' },
    { name: 'Galletas soda', description: 'Paquete', price: 2800, stock: 45, category: 'Panadería', unit: 'paq' },
    { name: 'Jabón de barra', description: 'Aseo general', price: 3200, stock: 50, category: 'Aseo', unit: 'und' },
    { name: 'Detergente 500g', description: 'En polvo', price: 5800, stock: 36, category: 'Aseo', unit: 'paq' },
    { name: 'Papel higiénico x4', description: 'Paquete', price: 7900, stock: 42, category: 'Aseo', unit: 'paq' },
    { name: 'Esponja multiusos', description: 'Unidad', price: 1800, stock: 55, category: 'Aseo', unit: 'und' }
  ];
  let user = db.users.find(u => u.username === USER || (u.business && u.business.slug === 'mercamono'));
  let changed = false;
  const forceReset = process.env.MERCA_RESET === '1';
  if (!user) {
    user = {
      id: ++db.lastUserId,
      username: USER,
      salt,
      hash,
      role: 'negocio',
      business: {
        name: 'merca mono limonar 2',
        email: 'mercamono@yopmail.com',
        phone: '3001234567',
        address: 'Barrio Centro',
        store_kind: 'market',
        categories,
        is_open: true,
        slug: 'mercamono'
      }
    };
    db.users.push(user);
    changed = true;
    console.log('Merca Mono user created:', USER);
  } else {
    user.username = USER;
    if (forceReset) {
      user.salt = salt;
      user.hash = hash;
      user.role = 'negocio';
      // Google-only accounts get a local password again
      if (!user.authProvider || user.authProvider === 'google') user.authProvider = 'local';
      changed = true;
      console.log('Merca Mono password reset:', USER);
    }
    user.business = user.business || {};
    if (!user.business.name) { user.business.name = 'merca mono limonar 2'; changed = true; }
    if (user.business.store_kind !== 'market') { user.business.store_kind = 'market'; changed = true; }
    const currentCats = Array.isArray(user.business.categories) ? user.business.categories.slice() : [];
    const mergedCats = categories.slice();
    currentCats.forEach(c => { if (c && !mergedCats.includes(c)) mergedCats.push(c); });
    if (mergedCats.join() !== currentCats.join()) {
      user.business.categories = mergedCats;
      changed = true;
    }
    if (user.business.slug !== 'mercamono') { user.business.slug = 'mercamono'; changed = true; }
    if (typeof user.business.is_open === 'undefined') { user.business.is_open = true; changed = true; }
  }

  const owned = db.menus.filter(m => m.ownerId === user.id);
  const ownedNames = new Set(owned.map(m => String(m.name || '').trim().toLowerCase()));
  const seededMenus = [];
  for (const p of seedProducts) {
    const key = String(p.name).trim().toLowerCase();
    if (ownedNames.has(key)) continue;
    const row = {
      id: ++db.lastMenuId,
      ownerId: user.id,
      name: p.name,
      description: p.description,
      price: p.price,
      stock: p.stock,
      category: p.category,
      unit: p.unit,
      available: true
    };
    db.menus.push(row);
    seededMenus.push(row);
    ownedNames.add(key);
    changed = true;
  }
  if (seededMenus.length) console.log('Merca Mono catalog +' + seededMenus.length + ' products');

  if (!changed) return;

  // Prefer targeted Mongo writes so huge base64 logos on other users don't block seeding
  if (usingMongo && mongoModels) {
    try {
      await mongoModels.User.updateOne(
        { username: USER },
        {
          $set: {
            legacyId: user.id,
            username: USER,
            role: 'negocio',
            salt: user.salt,
            hash: user.hash,
            business: user.business
          }
        },
        { upsert: true }
      );
      for (const m of seededMenus) {
        await mongoModels.Menu.updateOne(
          { legacyId: m.id },
          {
            $set: {
              legacyId: m.id,
              legacyOwnerId: m.ownerId,
              name: m.name,
              description: m.description || '',
              price: m.price,
              stock: m.stock,
              category: m.category || '',
              unit: m.unit || '',
              available: true
            }
          },
          { upsert: true }
        );
      }
      // Keep in-memory business fields even if full sync fails later
      console.log('Merca Mono persisted to Mongo');
    } catch (e) {
      console.warn('Merca Mono direct Mongo write failed:', e.message);
    }
  }

  try {
    await writeDB(db);
  } catch (e) {
    console.warn('Merca Mono writeDB failed (user kept in memory):', e.message);
  }
}

async function ensureBusinessSlugs() {
  db = readDB();
  const used = new Set(db.users.filter(u => u.business && u.business.slug).map(u => u.business.slug));
  let changed = false;
  db.users.forEach(u => {
    if (u.business && !u.business.slug) {
      const base = (u.business.name || u.username || 'biz').toString().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      let slug = base || ('biz-' + u.id);
      if (used.has(slug)) slug = slug + '-' + u.id;
      u.business.slug = slug;
      used.add(slug);
      changed = true;
    }
  });
  if (changed) await writeDB(db);
}

const readyPromise = (async () => {
  const maybe = await initMongoIfConfigured();
  if (maybe) db = maybe;
  else db = readFileDb();
  await ensureAdmin();
  await ensureSeedNegocio();
  await ensureMercaMono();
  await ensureBusinessSlugs();
})();

app.use(async (req, res, next) => {
  try {
    await readyPromise;
    if (!usingMongo) {
      await ensureMongoConnected();
    }
    if (usingMongo) {
      try { db = await loadDbFromMongo(); } catch (e) {
        console.warn('Mongo reload failed:', e.message);
        usingMongo = false;
        await ensureMongoConnected();
      }
    }
    // Serverless: seed Merca Mono if missing after Mongo reload
    const hasMerca = db.users && db.users.some(u => u.business && u.business.slug === 'mercamono');
    if (!hasMerca) {
      try {
        await ensureMercaMono();
      } catch (e) {
        console.warn('ensureMercaMono failed:', e.message);
      }
    }
    next();
  } catch (e) {
    console.error('DB init failed:', e);
    res.status(503).json({ error: 'Service initializing' });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true, mongo: usingMongo }));

if (!process.env.JWT_SECRET && IS_SERVERLESS) {
  console.warn('WARNING: JWT_SECRET is not set; sessions will break across instances');
}
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

function createToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '12h' });
}
function validateToken(token) {
  if (!token) return false;
  try { return jwt.verify(token, JWT_SECRET); } catch (e) { return false; }
}

function publicBaseUrl(req) {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/$/, '');
  const host = req.get('x-forwarded-host') || req.get('host') || 'tiagoo.vercel.app';
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  return `${proto}://${host}`;
}

function isEmailVerified(user) {
  if (!user) return false;
  if (user.authProvider === 'google') return true;
  if (typeof user.emailVerified === 'boolean') return user.emailVerified;
  // legacy accounts created before email confirmation
  return true;
}

function makeConfirmSecrets() {
  const confirmCode = String(Math.floor(100000 + Math.random() * 900000));
  const confirmToken = crypto.randomBytes(24).toString('hex');
  const confirmExpires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  return { confirmCode, confirmToken, confirmExpires };
}

function buildBusiness(role, business, username, userId, dbRef) {
  if (role !== 'negocio' || !business || typeof business !== 'object') return null;
  const biz = {
    name: business.name || '',
    email: business.email || '',
    phone: business.phone || '',
    address: business.address || '',
    is_open: true,
    store_kind: ['market', 'restaurant'].includes(business.store_kind) ? business.store_kind : 'restaurant',
    categories: Array.isArray(business.categories)
      ? business.categories.map(c => String(c).slice(0, 60)).filter(Boolean).slice(0, 20)
      : []
  };
  const slugBase = (business.name || username || 'biz').toString().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  let slug = slugBase || (`biz-${userId}`);
  const used = new Set(dbRef.users.filter(u => u.business && u.business.slug).map(u => u.business.slug));
  if (used.has(slug)) slug = slug + '-' + userId;
  biz.slug = slug;
  return biz;
}

function publicUser(user) {
  const out = {
    id: user.id,
    username: user.username,
    role: user.role,
    email: user.email || '',
    emailVerified: isEmailVerified(user),
    authProvider: user.authProvider || 'local'
  };
  if (user.business) out.business = user.business;
  return out;
}

async function verifyGoogleIdToken(credential) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new Error('Google Sign-In no está configurado (GOOGLE_CLIENT_ID)');
  if (!credential) throw new Error('credential required');
  const url = 'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential);
  const res = await fetch(url);
  if (!res.ok) throw new Error('Token de Google inválido');
  const data = await res.json();
  if (data.aud !== clientId) throw new Error('Client ID de Google no coincide');
  if (data.email_verified !== 'true' && data.email_verified !== true) throw new Error('Email de Google no verificado');
  if (!data.email) throw new Error('Google no devolvió email');
  return {
    googleId: data.sub,
    email: String(data.email).toLowerCase(),
    name: data.name || '',
    picture: data.picture || ''
  };
}

function requireAuth(req, res, next) {
  const parts = (req.headers.authorization || '').split(' ');
  if (parts.length === 2 && parts[0] === 'Bearer') {
    const payload = validateToken(parts[1]);
    if (payload) { req.token = parts[1]; req.userId = payload.userId; return next(); }
  }
  return res.status(401).json({ error: 'Unauthorized' });
}

function requireNegocio(req, res, next) {
  const parts = (req.headers.authorization || '').split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return res.status(401).json({ error: 'Unauthorized' });
  const payload = validateToken(parts[1]);
  if (!payload) return res.status(401).json({ error: 'Unauthorized' });
  req.token = parts[1];
  db = readDB();
  const user = db.users.find(u => u.id === payload.userId);
  if (!user || (user.role !== 'negocio' && user.role !== 'admin')) return res.status(403).json({ error: 'Forbidden' });
  req.user = { id: user.id, username: user.username, role: user.role, business: user.business || {} };
  next();
}

function requireAdmin(req, res, next) {
  const parts = (req.headers.authorization || '').split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return res.status(401).json({ error: 'Unauthorized' });
  const payload = validateToken(parts[1]);
  if (!payload) return res.status(401).json({ error: 'Unauthorized' });
  db = readDB();
  const user = db.users.find(u => u.id === payload.userId);
  if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  req.user = { id: user.id, username: user.username, role: user.role };
  next();
}

function defaultCheckoutBase(req) {
  const host = req.get('host') || 'localhost:4000';
  const proto = req.protocol || 'http';
  return `${proto}://${host}/checkout.html`;
}

function buildCheckoutUrl(req, order) {
  let checkout_base = process.env.CHECKOUT_BASE || defaultCheckoutBase(req);
  try {
    const u = new URL(checkout_base);
    if (u.pathname.endsWith('/checkout')) u.pathname = u.pathname + '.html';
    if (u.pathname === '/' || u.pathname === '') u.pathname = '/checkout.html';
    checkout_base = u.toString().replace(/#.*$/, '');
  } catch (e) {
    if (checkout_base.endsWith('/checkout')) checkout_base = checkout_base + '.html';
    if (checkout_base.endsWith('/')) checkout_base = checkout_base + 'checkout.html';
  }
  const sep = checkout_base.includes('?') ? '&' : '?';
  return `${checkout_base}${sep}orderId=${order.id}&total=${order.total}&token=${encodeURIComponent(order.proof_token || '')}`;
}

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  db = readDB();
  const user = db.users.find(u => u.username === username || (u.email && u.email.toLowerCase() === String(username).toLowerCase()));
  if (user && user.authProvider === 'google' && !user.hash) {
    return res.status(401).json({ error: 'Esta cuenta usa Google. Inicia sesión con Google.' });
  }
  if (user && verifyPassword(password, user.salt, user.hash)) {
    if (!isEmailVerified(user)) {
      return res.status(403).json({
        error: 'Debes confirmar tu correo antes de iniciar sesión',
        pending_confirmation: true,
        email: user.email || null
      });
    }
    return res.json({ token: createToken(user.id), user: publicUser(user) });
  }
  return res.status(401).json({ error: 'Invalid credentials' });
});

app.post('/api/auth/google', async (req, res) => {
  try {
    const { credential, role, business, complete } = req.body || {};
    const google = await verifyGoogleIdToken(credential);
    db = readDB();

    let user = db.users.find(u => u.googleId === google.googleId)
      || db.users.find(u => u.email && u.email.toLowerCase() === google.email);

    if (user) {
      user.googleId = google.googleId;
      user.email = google.email;
      user.emailVerified = true;
      if (!user.authProvider) user.authProvider = user.hash ? 'local' : 'google';
      if (!user.hash) user.authProvider = 'google';
      user.confirmToken = null;
      user.confirmCode = null;
      user.confirmExpires = null;
      await writeDB(db);
      return res.json({
        token: createToken(user.id),
        user: publicUser(user),
        created: false,
        message: 'Inicio de sesión con Google correcto'
      });
    }

    // New Google user: ask frontend for role/business before creating the account
    if (!complete) {
      return res.json({
        needs_registration: true,
        email: google.email,
        name: google.name || '',
        message: 'Confirma tu rol para terminar el registro con Google'
      });
    }

    const regRole = ['cliente', 'negocio'].includes(role) ? role : null;
    if (!regRole) return res.status(400).json({ error: 'Selecciona un rol: cliente o negocio' });
    if (regRole === 'negocio') {
      if (!business || !business.name || !business.phone || !business.address) {
        return res.status(400).json({
          error: 'Para negocio completa nombre, teléfono y dirección',
          needs_business: true
        });
      }
    }

    const baseUser = (google.email.split('@')[0] || 'user').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 18) || 'user';
    let username = baseUser;
    let n = 1;
    while (db.users.find(u => u.username === username)) {
      username = `${baseUser}${n++}`.slice(0, 24);
    }

    const userId = ++db.lastUserId;
    user = {
      id: userId,
      username,
      salt: null,
      hash: null,
      role: regRole,
      email: google.email,
      emailVerified: true,
      googleId: google.googleId,
      authProvider: 'google',
      confirmToken: null,
      confirmCode: null,
      confirmExpires: null
    };
    const biz = buildBusiness(regRole, { ...(business || {}), email: (business && business.email) || google.email }, username, userId, db);
    if (biz) user.business = biz;

    db.users.push(user);
    await writeDB(db);

    const mailContent = welcomeEmail({ name: google.name || (biz && biz.name), username });
    const mailResult = await sendMail({ to: google.email, ...mailContent });

    return res.json({
      token: createToken(user.id),
      user: publicUser(user),
      created: true,
      message: 'Te registraste con éxito en WhatsMenú. Te enviamos un breve mensaje de bienvenida a tu Gmail.',
      mail_sent: !!mailResult.sent
    });
  } catch (e) {
    return res.status(400).json({ error: e.message || 'Google auth failed' });
  }
});

app.post('/api/auth/confirm', async (req, res) => {
  const { token, code, email } = req.body || {};
  db = readDB();
  let user = null;
  if (token) {
    user = db.users.find(u => u.confirmToken && u.confirmToken === token);
  } else if (code && email) {
    user = db.users.find(u =>
      u.email && u.email.toLowerCase() === String(email).toLowerCase()
      && u.confirmCode && u.confirmCode === String(code).trim()
    );
  } else {
    return res.status(400).json({ error: 'token o (email + code) requeridos' });
  }
  if (!user) return res.status(400).json({ error: 'Código o enlace inválido' });
  if (user.confirmExpires && new Date(user.confirmExpires).getTime() < Date.now()) {
    return res.status(400).json({ error: 'El código expiró. Regístrate de nuevo o solicita otro.' });
  }
  user.emailVerified = true;
  user.confirmToken = null;
  user.confirmCode = null;
  user.confirmExpires = null;
  await writeDB(db);

  const mailContent = welcomeEmail({ name: user.business && user.business.name, username: user.username });
  if (user.email) await sendMail({ to: user.email, ...mailContent });

  return res.json({
    token: createToken(user.id),
    user: publicUser(user),
    message: 'Cuenta confirmada con éxito. ¡Bienvenido a WhatsMenú!'
  });
});

app.post('/api/auth/resend-confirm', async (req, res) => {
  const { email, username } = req.body || {};
  db = readDB();
  const user = db.users.find(u =>
    (email && u.email && u.email.toLowerCase() === String(email).toLowerCase())
    || (username && u.username === username)
  );
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  if (isEmailVerified(user)) return res.json({ ok: true, message: 'La cuenta ya está confirmada' });
  if (!user.email) return res.status(400).json({ error: 'La cuenta no tiene correo' });

  const secrets = makeConfirmSecrets();
  user.confirmCode = secrets.confirmCode;
  user.confirmToken = secrets.confirmToken;
  user.confirmExpires = secrets.confirmExpires;
  await writeDB(db);

  const confirmUrl = `${publicBaseUrl(req)}/admin.html?confirm=${encodeURIComponent(secrets.confirmToken)}`;
  const mailContent = confirmEmail({
    name: user.business && user.business.name,
    username: user.username,
    code: secrets.confirmCode,
    confirmUrl
  });
  const mailResult = await sendMail({ to: user.email, ...mailContent });
  const payload = {
    ok: true,
    message: mailResult.sent
      ? 'Te reenviamos el código de confirmación a tu correo'
      : 'No pudimos enviar el correo. Usa el código o enlace de esta respuesta.',
    mail_sent: !!mailResult.sent,
    email: user.email
  };
  if (!mailResult.sent) {
    payload.dev_confirm_code = secrets.confirmCode;
    payload.dev_confirm_url = confirmUrl;
  }
  return res.json(payload);
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  db = readDB();
  const users = (db.users || []).map(u => ({
    id: u.id,
    username: u.username,
    role: u.role,
    business: u.business ? {
      name: u.business.name || '',
      email: u.business.email || '',
      phone: u.business.phone || '',
      address: u.business.address || '',
      slug: u.business.slug || '',
      logo: u.business.logo ? true : false
    } : null
  }));
  res.json(users);
});

app.get('/api/admin/negocios', requireAdmin, (req, res) => {
  db = readDB();
  const negocios = (db.users || [])
    .filter(u => u.role === 'negocio')
    .map(u => {
      const menus = (db.menus || []).filter(m => m.ownerId === u.id).length;
      const orders = (db.orders || []).filter(o => o.ownerId === u.id).length;
      return {
        id: u.id,
        username: u.username,
        business: u.business || {},
        stats: { menus, orders },
        public_url: u.business && u.business.slug ? `/b/${u.business.slug}` : null
      };
    });
  res.json(negocios);
});

app.get('/api/stores', (req, res) => {
  db = readDB();
  const stores = (db.users || [])
    .filter(u => u.role === 'negocio' && u.business && u.business.slug)
    .map(u => {
      const b = u.business || {};
      const kind = b.store_kind === 'market' ? 'market' : 'restaurant';
      return {
        id: u.id,
        name: b.name || u.username,
        slug: b.slug,
        logo: b.logo || null,
        banner: b.banner || null,
        address: b.address || '',
        phone: b.phone || '',
        store_kind: kind,
        is_open: typeof b.is_open === 'undefined' ? true : !!b.is_open,
        public_url: `/b/${b.slug}`
      };
    })
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'es', { sensitivity: 'base' }));
  res.json(stores);
});

app.get('/api/admin/status', requireAdmin, async (req, res) => {
  const started = Date.now();
  db = readDB();

  const mongoStates = { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' };
  let mongo = {
    configured: !!(process.env.MONGO_URI || process.env.MONGOURL || process.env.MONGOURL_SHORT),
    using: usingMongo,
    readyState: null,
    readyLabel: 'n/a',
    ping_ms: null,
    ok: false,
    error: null
  };

  if (mongoModels && mongoModels.mongoose) {
    const state = mongoModels.mongoose.connection.readyState;
    mongo.readyState = state;
    mongo.readyLabel = mongoStates[state] || String(state);
    if (state === 1) {
      try {
        const t0 = Date.now();
        await mongoModels.mongoose.connection.db.admin().command({ ping: 1 });
        mongo.ping_ms = Date.now() - t0;
        mongo.ok = true;
      } catch (e) {
        mongo.error = e.message;
        mongo.ok = false;
      }
    } else {
      mongo.ok = false;
      mongo.error = 'Mongo not connected';
    }
  } else if (!mongo.configured) {
    mongo.ok = true; // file DB mode is intentional
    mongo.readyLabel = 'file-db';
  }

  const counts = {
    users: (db.users || []).length,
    negocios: (db.users || []).filter(u => u.role === 'negocio').length,
    menus: (db.menus || []).length,
    orders: (db.orders || []).length,
    inventory: (db.inventories || []).length,
    cash: (db.cash || []).length
  };

  const checks = [];
  const pushCheck = (id, label, ok, detail) => checks.push({ id, label, ok: !!ok, detail: detail || '' });

  pushCheck('api', 'API Express', true, `Respuesta en ${Date.now() - started} ms`);
  pushCheck('auth', 'JWT / sesiones', !!process.env.JWT_SECRET, process.env.JWT_SECRET ? 'JWT_SECRET configurado' : 'JWT_SECRET ausente');
  const mail = mailConfig();
  pushCheck('mail', 'Correo (SMTP/Resend)', mail.configured,
    mail.configured
      ? `Proveedor: ${mail.provider}${mail.from ? '' : ' · falta MAIL_FROM'}`
      : 'Sin RESEND_API_KEY ni SMTP_* · los códigos se muestran en pantalla');
  pushCheck('google', 'Google Sign-In', !!process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_ID ? 'GOOGLE_CLIENT_ID configurado' : 'GOOGLE_CLIENT_ID ausente');
  pushCheck('mongo', 'Base de datos MongoDB', mongo.ok || (!mongo.configured && !usingMongo),
    mongo.configured
      ? (mongo.ok
        ? `Conectado · ping ${mongo.ping_ms} ms`
        : `${mongo.error || mongo.readyLabel} · Revisa Network Access en Atlas (permite 0.0.0.0/0 para Vercel)`)
      : 'Sin MONGO_URI · usando archivo local/tmp');
  pushCheck('memory_db', 'Datos en memoria', !!(db && db.users), `${counts.users} users · ${counts.orders} orders · ${counts.menus} menus`);

  // Probe key public routes quickly (same process)
  const probes = [
    { id: 'health', label: 'GET /api/health', path: '/api/health' },
    { id: 'config', label: 'GET /api/config', path: '/api/config' }
  ];
  for (const p of probes) {
    const t0 = Date.now();
    try {
      if (p.path === '/api/health') {
        pushCheck(p.id, p.label, true, `ok · ${Date.now() - t0} ms · mongo=${usingMongo}`);
      } else if (p.path === '/api/config') {
        pushCheck(p.id, p.label, true, `ok · ${Date.now() - t0} ms`);
      }
    } catch (e) {
      pushCheck(p.id, p.label, false, e.message);
    }
  }

  // Sample storefronts if present
  const sampleSlugs = (db.users || [])
    .filter(u => u.business && u.business.slug)
    .slice(0, 3)
    .map(u => u.business.slug);
  for (const slug of sampleSlugs) {
    const owner = db.users.find(u => u.business && u.business.slug === slug);
    const menuCount = (db.menus || []).filter(m => m.ownerId === owner.id).length;
    pushCheck('store_' + slug, `Negocio /b/${slug}`, !!owner, `${menuCount} productos · ${owner.business.store_kind || 'restaurant'}`);
  }

  const overallOk = checks.every(c => c.ok);
  res.json({
    ok: overallOk,
    checked_at: new Date().toISOString(),
    duration_ms: Date.now() - started,
    runtime: {
      node: process.version,
      platform: process.platform,
      uptime_s: Math.round(process.uptime()),
      memory_mb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
      serverless: !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME),
      env: process.env.VERCEL_ENV || process.env.NODE_ENV || 'unknown'
    },
    mongo,
    counts,
    checks,
    env: {
      JWT_SECRET: !!process.env.JWT_SECRET,
      MONGO_URI: !!(process.env.MONGO_URI || process.env.MONGOURL || process.env.MONGOURL_SHORT),
      CHECKOUT_BASE: !!process.env.CHECKOUT_BASE,
      WHATSAPP_NUMBER: !!process.env.WHATSAPP_NUMBER,
      GOOGLE_CLIENT_ID: !!process.env.GOOGLE_CLIENT_ID,
      RESEND_API_KEY: mail.RESEND_API_KEY,
      SMTP_HOST: mail.SMTP_HOST,
      SMTP_USER: mail.SMTP_USER,
      SMTP_PASS: mail.SMTP_PASS,
      MAIL_FROM: mail.from
    },
    mail
  });
});

app.post('/api/admin/test-mail', requireAdmin, async (req, res) => {
  const to = String((req.body && req.body.to) || '').trim().toLowerCase();
  if (!to || !/^\S+@\S+\.\S+$/.test(to)) {
    return res.status(400).json({ error: 'Indica un correo destino válido en "to"' });
  }
  const mail = mailConfig();
  if (!mail.configured) {
    return res.status(400).json({
      error: 'Correo no configurado. Agrega RESEND_API_KEY o SMTP_HOST/SMTP_USER/SMTP_PASS en Vercel.',
      mail
    });
  }
  const result = await sendMail({
    to,
    subject: 'Prueba WhatsMenú — correo OK',
    text: 'Este es un correo de prueba desde WhatsMenú. Si lo recibes, SMTP/Resend está bien configurado.',
    html: '<p>Este es un correo de prueba desde <strong>WhatsMenú</strong>.</p><p>Si lo recibes, el envío está bien configurado.</p>'
  });
  if (!result.sent) {
    return res.status(502).json({ ok: false, error: result.reason || 'No se pudo enviar', mail });
  }
  res.json({ ok: true, provider: result.provider, to, message: 'Correo de prueba enviado' });
});

app.post('/api/register', async (req, res) => {
  const { username, password, role, email, business } = req.body || {};
  if (!username || !password || !role) return res.status(400).json({ error: 'username, password and role required' });
  if (password.length < 6) return res.status(400).json({ error: 'password must be at least 6 characters' });
  if (!['cliente', 'negocio'].includes(role)) return res.status(400).json({ error: 'role must be cliente or negocio' });

  const emailNorm = String(email || (business && business.email) || '').trim().toLowerCase();
  if (!emailNorm || !/^\S+@\S+\.\S+$/.test(emailNorm)) {
    return res.status(400).json({ error: 'email válido requerido para confirmar la cuenta' });
  }

  db = readDB();
  if (db.users.find(u => u.username === username)) return res.status(400).json({ error: 'username already exists' });
  if (db.users.find(u => u.email && u.email.toLowerCase() === emailNorm)) {
    return res.status(400).json({ error: 'Ya existe una cuenta con ese correo' });
  }

  const { salt, hash } = hashPassword(password);
  const secrets = makeConfirmSecrets();
  const userId = ++db.lastUserId;
  const user = {
    id: userId,
    username,
    salt,
    hash,
    role,
    email: emailNorm,
    emailVerified: false,
    authProvider: 'local',
    googleId: null,
    confirmToken: secrets.confirmToken,
    confirmCode: secrets.confirmCode,
    confirmExpires: secrets.confirmExpires
  };
  const biz = buildBusiness(role, { ...(business || {}), email: emailNorm }, username, userId, db);
  if (biz) user.business = biz;

  db.users.push(user);
  await writeDB(db);

  const confirmUrl = `${publicBaseUrl(req)}/admin.html?confirm=${encodeURIComponent(secrets.confirmToken)}`;
  const mailContent = confirmEmail({
    name: biz && biz.name,
    username,
    code: secrets.confirmCode,
    confirmUrl
  });
  const mailResult = await sendMail({ to: emailNorm, ...mailContent });

  const payload = {
    pending_confirmation: true,
    email: emailNorm,
    message: mailResult.sent
      ? 'Te enviamos un código y un enlace a tu correo para confirmar la creación de la cuenta.'
      : 'Cuenta creada. Confirma con el código o enlace (el correo no se pudo enviar automáticamente).',
    mail_sent: !!mailResult.sent
  };
  if (!mailResult.sent) {
    payload.confirm_code = secrets.confirmCode;
    payload.confirm_url = confirmUrl;
  }
  res.json(payload);
});

app.get('/api/me', requireAuth, (req, res) => {
  db = readDB();
  const user = db.users.find(u => u.id === req.userId);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const userOut = { id: user.id, username: user.username, role: user.role };
  if (user.business) userOut.business = user.business;
  res.json(userOut);
});

app.put('/api/me', requireAuth, async (req, res) => {
  db = readDB();
  const user = db.users.find(u => u.id === req.userId);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { business } = req.body || {};
  if (!business || typeof business !== 'object') return res.status(400).json({ error: 'business object required' });
  user.business = user.business || {};
  ['name', 'email', 'phone', 'address', 'logo', 'banner'].forEach(k => {
    if (typeof business[k] !== 'undefined') user.business[k] = business[k];
  });
  if (typeof business.store_kind !== 'undefined') {
    user.business.store_kind = ['market', 'restaurant'].includes(business.store_kind) ? business.store_kind : 'restaurant';
  }
  if (Array.isArray(business.categories)) {
    user.business.categories = business.categories.map(c => String(c).slice(0, 60)).filter(Boolean).slice(0, 20);
  }
  if (typeof business.is_open !== 'undefined') user.business.is_open = !!business.is_open;
  await writeDB(db);
  res.json({ id: user.id, username: user.username, role: user.role, business: user.business });
});

app.post('/api/me/open-status', requireNegocio, async (req, res) => {
  db = readDB();
  const user = db.users.find(u => u.id === req.user.id);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  if (user.role === 'admin') return res.status(400).json({ error: 'Admin has no public storefront status' });
  user.business = user.business || {};
  if (typeof req.body?.is_open === 'undefined') {
    return res.status(400).json({ error: 'is_open boolean required' });
  }
  user.business.is_open = !!req.body.is_open;
  await writeDB(db);
  res.json({ ok: true, is_open: user.business.is_open, business: user.business });
});

async function saveBusinessImage(req, res, field) {
  db = readDB();
  const user = db.users.find(u => u.id === req.userId);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  if (user.role !== 'negocio' && user.role !== 'admin') {
    return res.status(403).json({ error: 'Only negocio can upload business images' });
  }
  const { image } = req.body || {};
  if (!image || typeof image !== 'string') return res.status(400).json({ error: 'image data required' });
  const m = image.match(/^data:(image\/(png|jpeg|jpg|webp));base64,(.+)$/);
  if (!m) return res.status(400).json({ error: 'invalid image data' });
  user.business = user.business || {};
  if (IS_SERVERLESS) {
    if (image.length > 1_500_000) return res.status(400).json({ error: 'image too large (max ~1MB)' });
    user.business[field] = image;
  } else {
    const ext = m[2] === 'jpeg' ? 'jpg' : m[2];
    const filename = `${user.id}_${field}_${Date.now()}.${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), Buffer.from(m[3], 'base64'));
    user.business[field] = `/uploads/${filename}`;
  }
  await writeDB(db);
  res.json({ url: user.business[field], field });
}

app.post('/api/me/avatar', requireAuth, (req, res) => saveBusinessImage(req, res, 'logo'));
app.post('/api/me/banner', requireAuth, (req, res) => saveBusinessImage(req, res, 'banner'));

function persistMenuImage(ownerId, menuId, image) {
  if (image === null || image === '') return null;
  if (typeof image !== 'string') return undefined;
  if (image.startsWith('/uploads/')) return image;
  const m = image.match(/^data:(image\/(png|jpeg|jpg|webp));base64,(.+)$/);
  if (!m) return undefined;
  if (IS_SERVERLESS) {
    if (image.length > 1_500_000) {
      const err = new Error('image too large (max ~1MB)');
      err.status = 400;
      throw err;
    }
    return image;
  }
  const ext = m[2] === 'jpeg' ? 'jpg' : m[2];
  const filename = `${ownerId}_menu_${menuId || 'new'}_${Date.now()}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), Buffer.from(m[3], 'base64'));
  return `/uploads/${filename}`;
}

app.get('/api/config', (req, res) => {
  res.json({
    whatsapp_number: process.env.WHATSAPP_NUMBER || '573001234567',
    checkout_base: process.env.CHECKOUT_BASE || defaultCheckoutBase(req),
    google_client_id: process.env.GOOGLE_CLIENT_ID || '',
    google_enabled: !!process.env.GOOGLE_CLIENT_ID
  });
});

app.get('/api/menu', (req, res) => {
  const ownerSlug = req.query.ownerSlug;
  db = readDB();
  if (ownerSlug) {
    const owner = db.users.find(u => u.business && u.business.slug === ownerSlug);
    if (!owner) return res.status(404).json({ error: 'Business not found' });
    // Only this business's menu — never fall back to global seed items
    return res.json(db.menus.filter(m => m.ownerId === owner.id));
  }
  const authHeader = (req.headers.authorization || '').split(' ');
  if (authHeader.length === 2 && authHeader[0] === 'Bearer') {
    const payload = validateToken(authHeader[1]);
    if (payload) {
      const user = db.users.find(u => u.id === payload.userId);
      if (user && user.role === 'negocio') return res.json(db.menus.filter(m => m.ownerId === user.id));
    }
  }
  res.json(db.menus.filter(m => !m.ownerId));
});

app.get('/api/menu/my', requireNegocio, (req, res) => {
  db = readDB();
  res.json(db.menus.filter(m => m.ownerId === req.user.id));
});

app.post('/api/menu', requireNegocio, async (req, res) => {
  const { name, price, available, description, category, stock, unit, image } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  db = readDB();
  const id = ++db.lastMenuId;
  let imageUrl = null;
  try {
    if (typeof image !== 'undefined') {
      const persisted = persistMenuImage(req.user.id, id, image);
      if (persisted === undefined && image) return res.status(400).json({ error: 'invalid image data' });
      imageUrl = persisted || null;
    }
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message || 'invalid image' });
  }
  const item = {
    id,
    ownerId: req.user.id,
    name: String(name).slice(0, 120),
    description: description != null ? String(description).slice(0, 400) : '',
    price: Number(price || 0),
    category: category != null ? String(category).slice(0, 60) : '',
    unit: unit != null ? String(unit).slice(0, 30) : '',
    stock: (stock === '' || stock == null) ? null : Math.max(0, Number(stock)),
    available: typeof available === 'undefined' ? true : !!available,
    image: imageUrl
  };
  if (Number.isNaN(item.stock)) item.stock = null;
  db.menus.push(item);
  await writeDB(db);
  res.json(item);
});

app.put('/api/menu/:id', requireNegocio, async (req, res) => {
  const id = Number(req.params.id);
  db = readDB();
  const idx = db.menus.findIndex(m => m.id === id && m.ownerId === req.user.id);
  if (idx === -1) return res.status(404).json({ error: 'Menu item not found' });
  const body = req.body || {};
  ['name', 'price', 'available', 'description', 'category', 'unit'].forEach(k => {
    if (typeof body[k] !== 'undefined') db.menus[idx][k] = body[k];
  });
  if (typeof body.stock !== 'undefined') {
    db.menus[idx].stock = (body.stock === '' || body.stock == null) ? null : Math.max(0, Number(body.stock));
    if (Number.isNaN(db.menus[idx].stock)) db.menus[idx].stock = null;
  }
  if (typeof body.name === 'string') db.menus[idx].name = body.name.slice(0, 120);
  if (typeof body.description === 'string') db.menus[idx].description = body.description.slice(0, 400);
  if (typeof body.category === 'string') db.menus[idx].category = body.category.slice(0, 60);
  if (typeof body.unit === 'string') db.menus[idx].unit = body.unit.slice(0, 30);
  if (typeof body.price !== 'undefined') db.menus[idx].price = Number(body.price || 0);
  if (typeof body.available !== 'undefined') db.menus[idx].available = !!body.available;
  if (typeof body.image !== 'undefined') {
    try {
      const persisted = persistMenuImage(req.user.id, id, body.image);
      if (persisted === undefined && body.image) return res.status(400).json({ error: 'invalid image data' });
      db.menus[idx].image = persisted || null;
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message || 'invalid image' });
    }
  }
  await writeDB(db);
  res.json(db.menus[idx]);
});

app.delete('/api/menu/:id', requireNegocio, async (req, res) => {
  const id = Number(req.params.id);
  db = readDB();
  const idx = db.menus.findIndex(m => m.id === id && m.ownerId === req.user.id);
  if (idx === -1) return res.status(404).json({ error: 'Menu item not found' });
  const removed = db.menus.splice(idx, 1)[0];
  await writeDB(db);
  if (usingMongo && mongoModels) {
    try { await mongoModels.Menu.deleteOne({ legacyId: id }); } catch (e) { console.warn(e.message); }
  }
  res.json(removed);
});

app.get('/api/b/:slug', (req, res) => {
  db = readDB();
  const user = db.users.find(u => u.business && u.business.slug === req.params.slug);
  if (!user) return res.status(404).json({ error: 'Business not found' });
  const b = Object.assign({}, user.business);
  if (typeof b.is_open === 'undefined') b.is_open = true;
  if (!b.store_kind) b.store_kind = 'restaurant';
  res.json({ username: user.username, business: b, slug: user.business.slug });
});

app.get('/b/:slug', (req, res) => {
  db = readDB();
  const user = db.users.find(u => u.business && u.business.slug === req.params.slug);
  const kind = user && user.business && user.business.store_kind;
  const file = kind === 'market' ? 'market.html' : 'business.html';
  res.sendFile(path.join(__dirname, '../frontend', file));
});

function payMethodLabel(method) {
  if (method === 'transferencia') return 'Transferencia';
  if (method === 'efectivo') return 'Efectivo';
  return method || '';
}

function findCashByOrder(db, ownerId, orderId, type) {
  return (db.cash || []).find(c =>
    c.ownerId === ownerId &&
    Number(c.orderId) === Number(orderId) &&
    (!type || c.type === type)
  );
}

/** Register a sale movement in caja for a new/paid order (idempotent by orderId). */
function ensureCashSaleForOrder(db, order) {
  if (!order || !order.ownerId || !order.id) return null;
  const amount = Number(order.total || 0);
  if (!(amount > 0)) return null;
  const existing = findCashByOrder(db, order.ownerId, order.id, 'sale');
  if (existing) return existing;
  const pay = payMethodLabel(order.payment_method);
  const note = [
    'Pedido #' + order.id,
    order.customer_name ? String(order.customer_name).slice(0, 60) : null,
    pay || null
  ].filter(Boolean).join(' · ');
  const mv = {
    id: ++db.lastCashId,
    ownerId: order.ownerId,
    type: 'sale',
    amount,
    note,
    orderId: order.id,
    created_at: new Date().toISOString()
  };
  db.cash.push(mv);
  return mv;
}

/** Reverse a previous sale in caja when an order is cancelled (idempotent). */
function ensureCashReversalForOrder(db, order, reason) {
  if (!order || !order.ownerId || !order.id) return null;
  const amount = Number(order.total || 0);
  if (!(amount > 0)) return null;
  const existingSale = findCashByOrder(db, order.ownerId, order.id, 'sale');
  if (!existingSale) return null;
  const existingRev = findCashByOrder(db, order.ownerId, order.id, 'expense');
  if (existingRev) return existingRev;
  const mv = {
    id: ++db.lastCashId,
    ownerId: order.ownerId,
    type: 'expense',
    amount,
    note: 'Anulación pedido #' + order.id + (reason ? (': ' + String(reason).slice(0, 120)) : ''),
    orderId: order.id,
    created_at: new Date().toISOString()
  };
  db.cash.push(mv);
  return mv;
}

app.post('/api/orders', async (req, res) => {
  const { customer_name, customer_phone, customer_address, customer_notes, items, ownerSlug, payment_method } = req.body || {};
  if (!items || !Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items array required' });
  const payMethod = ['efectivo', 'transferencia'].includes(payment_method) ? payment_method : 'efectivo';
  const address = customer_address ? String(customer_address).trim().slice(0, 200) : '';
  if (!address) return res.status(400).json({ error: 'Dirección de entrega requerida' });
  const notes = customer_notes ? String(customer_notes).trim().slice(0, 300) : null;
  db = readDB();

  let ownerId = null;
  let owner = null;
  if (ownerSlug) {
    owner = db.users.find(u => u.business && u.business.slug === ownerSlug);
    if (!owner) return res.status(404).json({ error: 'Business not found' });
    ownerId = owner.id;
    const isOpen = owner.business && typeof owner.business.is_open === 'undefined' ? true : !!owner.business.is_open;
    if (!isOpen) return res.status(403).json({ error: 'El negocio no está disponible para pedidos en este momento' });
  }

  // Server-side pricing — never trust client prices
  const pricedItems = [];
  for (const raw of items) {
    const id = Number(raw.id);
    const qty = Math.max(1, Math.min(99, Number(raw.qty || 1)));
    let menuItem = db.menus.find(m => m.id === id && (ownerId ? m.ownerId === ownerId : !m.ownerId));
    if (!menuItem && ownerId) {
      // allow only owned items for business orders
      menuItem = null;
    }
    if (!menuItem) return res.status(400).json({ error: `Invalid menu item: ${raw.id}` });
    if (!menuItem.available) return res.status(400).json({ error: `Item unavailable: ${menuItem.name}` });
    if (typeof menuItem.stock === 'number' && menuItem.stock < qty) {
      return res.status(400).json({ error: `Stock insuficiente: ${menuItem.name} (disp. ${menuItem.stock})` });
    }
    pricedItems.push({
      id: menuItem.id,
      name: menuItem.name,
      price: Number(menuItem.price),
      qty,
      category: menuItem.category || ''
    });
  }

  const total = pricedItems.reduce((s, i) => s + i.price * i.qty, 0);
  // Decrement stock when tracked
  for (const line of pricedItems) {
    const idx = db.menus.findIndex(m => m.id === line.id);
    if (idx !== -1 && typeof db.menus[idx].stock === 'number') {
      db.menus[idx].stock = Math.max(0, db.menus[idx].stock - line.qty);
      if (db.menus[idx].stock === 0) db.menus[idx].available = false;
    }
  }
  const order = {    id: ++db.lastOrderId,
    ownerId,
    customer_name: String(customer_name || 'Anon').slice(0, 80),
    customer_phone: customer_phone ? String(customer_phone).slice(0, 30) : null,
    customer_address: address,
    customer_notes: notes || null,
    payment_method: payMethod,
    items: pricedItems,
    total,
    status: 'pending',
    proof_token: crypto.randomBytes(16).toString('hex'),
    created_at: new Date().toISOString()
  };
  db.orders.unshift(order);
  if (ownerId) ensureCashSaleForOrder(db, order);
  await writeDB(db);

  const checkout_url = buildCheckoutUrl(req, order);
  const { proof_token, ...publicOrder } = order;
  res.json({ ...publicOrder, checkout_url });
});

app.get('/api/orders', requireNegocio, (req, res) => {
  db = readDB();
  res.json(db.orders.filter(o => o.ownerId === req.user.id).slice(0, 50));
});

app.get('/api/inventory', requireNegocio, (req, res) => {
  db = readDB();
  res.json(db.inventories.filter(i => i.ownerId === req.user.id));
});

app.post('/api/inventory', requireNegocio, async (req, res) => {
  const { name, qty, unit } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  db = readDB();
  const item = { id: ++db.lastInventoryId, ownerId: req.user.id, name, qty: Number(qty || 0), unit: unit || '' };
  db.inventories.push(item);
  await writeDB(db);
  res.json(item);
});

app.put('/api/inventory/:id', requireNegocio, async (req, res) => {
  const id = Number(req.params.id);
  db = readDB();
  const idx = db.inventories.findIndex(i => i.id === id && i.ownerId === req.user.id);
  if (idx === -1) return res.status(404).json({ error: 'Item not found' });
  const body = req.body || {};
  ['name', 'qty', 'unit'].forEach(k => { if (typeof body[k] !== 'undefined') db.inventories[idx][k] = body[k]; });
  await writeDB(db);
  res.json(db.inventories[idx]);
});

app.delete('/api/inventory/:id', requireNegocio, async (req, res) => {
  const id = Number(req.params.id);
  db = readDB();
  const idx = db.inventories.findIndex(i => i.id === id && i.ownerId === req.user.id);
  if (idx === -1) return res.status(404).json({ error: 'Item not found' });
  const removed = db.inventories.splice(idx, 1)[0];
  await writeDB(db);
  if (usingMongo && mongoModels) {
    try { await mongoModels.Inventory.deleteOne({ legacyId: id }); } catch (e) { console.warn(e.message); }
  }
  res.json(removed);
});

app.get('/api/cash', requireNegocio, (req, res) => {
  db = readDB();
  res.json(db.cash.filter(c => c.ownerId === req.user.id));
});

function reportDateInRange(iso, from, to) {
  if (!from && !to) return true;
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  if (from) {
    const start = new Date(from);
    start.setHours(0, 0, 0, 0);
    if (t < start.getTime()) return false;
  }
  if (to) {
    const end = new Date(to);
    end.setHours(23, 59, 59, 999);
    if (t > end.getTime()) return false;
  }
  return true;
}

app.get('/api/reports', requireNegocio, (req, res) => {
  db = readDB();
  const type = String(req.query.type || 'orders').toLowerCase();
  const from = req.query.from ? String(req.query.from) : '';
  const to = req.query.to ? String(req.query.to) : '';
  const ownerId = req.user.id;
  const bizName = (req.user.business && req.user.business.name) || req.user.username || 'Negocio';

  if (type === 'orders') {
    const rows = db.orders
      .filter(o => o.ownerId === ownerId && reportDateInRange(o.created_at, from, to))
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
      .map(o => ({
        id: o.id,
        cliente: o.customer_name || 'Anon',
        telefono: o.customer_phone || '',
        direccion: o.customer_address || '',
        comentarios: o.customer_notes || '',
        items: (o.items || []).map(i => `${i.name} x${i.qty}`).join('; '),
        total: Number(o.total || 0),
        estado: o.status,
        creado: o.created_at || '',
        pagado: o.paid_at || ''
      }));
    return res.json({ type, from, to, business: bizName, generated_at: new Date().toISOString(), rows, summary: {
      pedidos: rows.length,
      pagados: rows.filter(r => r.estado === 'paid').length,
      pendientes: rows.filter(r => r.estado !== 'paid').length,
      ventas: rows.filter(r => r.estado === 'paid').reduce((s, r) => s + r.total, 0),
      por_cobrar: rows.filter(r => r.estado !== 'paid').reduce((s, r) => s + r.total, 0)
    }});
  }

  if (type === 'cash') {
    const rows = db.cash
      .filter(c => c.ownerId === ownerId && reportDateInRange(c.created_at, from, to))
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
      .map(c => ({
        id: c.id,
        tipo: c.type,
        monto: Number(c.amount || 0),
        nota: c.note || '',
        fecha: c.created_at || ''
      }));
    const inflow = rows.filter(r => r.tipo === 'in' || r.tipo === 'sale').reduce((s, r) => s + r.monto, 0);
    const outflow = rows.filter(r => r.tipo === 'out' || r.tipo === 'expense').reduce((s, r) => s + r.monto, 0);
    return res.json({ type, from, to, business: bizName, generated_at: new Date().toISOString(), rows, summary: {
      movimientos: rows.length,
      ingresos: inflow,
      egresos: outflow,
      neto: inflow - outflow
    }});
  }

  if (type === 'inventory') {
    const rows = db.inventories
      .filter(i => i.ownerId === ownerId)
      .map(i => ({
        id: i.id,
        nombre: i.name,
        cantidad: Number(i.qty || 0),
        unidad: i.unit || ''
      }));
    return res.json({ type, from, to, business: bizName, generated_at: new Date().toISOString(), rows, summary: {
      items: rows.length,
      unidades: rows.reduce((s, r) => s + r.cantidad, 0)
    }});
  }

  if (type === 'sales') {
    const paid = db.orders.filter(o =>
      o.ownerId === ownerId &&
      o.status === 'paid' &&
      reportDateInRange(o.paid_at || o.created_at, from, to)
    );
    const byDay = {};
    const byProduct = {};
    paid.forEach(o => {
      const dayKey = (o.paid_at || o.created_at || '').slice(0, 10) || 'sin-fecha';
      if (!byDay[dayKey]) byDay[dayKey] = { fecha: dayKey, pedidos: 0, total: 0 };
      byDay[dayKey].pedidos += 1;
      byDay[dayKey].total += Number(o.total || 0);
      (o.items || []).forEach(it => {
        const name = it.name || 'Item';
        if (!byProduct[name]) byProduct[name] = { producto: name, cantidad: 0, total: 0 };
        byProduct[name].cantidad += Number(it.qty || 0);
        byProduct[name].total += Number(it.price || 0) * Number(it.qty || 0);
      });
    });
    const days = Object.values(byDay).sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
    const products = Object.values(byProduct).sort((a, b) => b.total - a.total);
    return res.json({
      type, from, to, business: bizName, generated_at: new Date().toISOString(),
      rows: days,
      products,
      summary: {
        pedidos_pagados: paid.length,
        ventas: paid.reduce((s, o) => s + Number(o.total || 0), 0),
        productos: products.length
      }
    });
  }

  return res.status(400).json({ error: 'type must be orders, cash, inventory or sales' });
});

app.post('/api/cash', requireNegocio, async (req, res) => {
  let { type, amount, note } = req.body || {};
  if (!type || typeof amount === 'undefined') return res.status(400).json({ error: 'type and amount required' });
  // Admin UI uses income/egress; normalize to stored types
  const typeMap = { income: 'in', egress: 'out', in: 'in', out: 'out', sale: 'sale', expense: 'expense' };
  type = typeMap[String(type)] || String(type);
  if (!['in', 'out', 'sale', 'expense'].includes(type)) return res.status(400).json({ error: 'invalid cash type' });
  db = readDB();
  const mv = {
    id: ++db.lastCashId,
    ownerId: req.user.id,
    type,
    amount: Number(amount),
    note: note || '',
    orderId: null,
    created_at: new Date().toISOString()
  };
  db.cash.push(mv);
  await writeDB(db);
  res.json(mv);
});

app.get('/api/orders/:id', requireNegocio, (req, res) => {
  db = readDB();
  const order = db.orders.find(o => o.id === Number(req.params.id) && o.ownerId === req.user.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const { proof_token, ...safe } = order;
  res.json(safe);
});

app.post('/api/orders/:id/confirm-payment', requireNegocio, async (req, res) => {
  db = readDB();
  const orderIdx = db.orders.findIndex(o => o.id === Number(req.params.id) && o.ownerId === req.user.id);
  if (orderIdx === -1) return res.status(404).json({ error: 'Order not found' });
  db.orders[orderIdx].status = 'paid';
  db.orders[orderIdx].proof_url = req.body.proof_url || db.orders[orderIdx].proof_url || null;
  db.orders[orderIdx].paid_at = new Date().toISOString();
  // Backfill caja for older orders that predate auto cash registration
  ensureCashSaleForOrder(db, db.orders[orderIdx]);
  await writeDB(db);
  const { proof_token, ...safe } = db.orders[orderIdx];
  res.json(safe);
});

app.post('/api/orders/:id/dispatch', requireNegocio, async (req, res) => {
  db = readDB();
  const orderIdx = db.orders.findIndex(o => o.id === Number(req.params.id) && o.ownerId === req.user.id);
  if (orderIdx === -1) return res.status(404).json({ error: 'Order not found' });
  const order = db.orders[orderIdx];
  if (order.status === 'cancelled') {
    return res.status(400).json({ error: 'No se puede despachar un pedido cancelado' });
  }
  if (order.status === 'delivered') {
    return res.status(400).json({ error: 'El pedido ya fue entregado' });
  }
  db.orders[orderIdx].status = 'out_for_delivery';
  db.orders[orderIdx].dispatched_at = new Date().toISOString();
  await writeDB(db);
  const { proof_token, ...safe } = db.orders[orderIdx];
  res.json(safe);
});

app.post('/api/orders/:id/deliver', requireNegocio, async (req, res) => {
  db = readDB();
  const orderIdx = db.orders.findIndex(o => o.id === Number(req.params.id) && o.ownerId === req.user.id);
  if (orderIdx === -1) return res.status(404).json({ error: 'Order not found' });
  const order = db.orders[orderIdx];
  if (order.status === 'cancelled') {
    return res.status(400).json({ error: 'No se puede entregar un pedido cancelado' });
  }
  if (order.status !== 'out_for_delivery' && order.status !== 'paid') {
    return res.status(400).json({ error: 'El pedido debe estar en domicilio (o pagado) para confirmar la entrega' });
  }
  db.orders[orderIdx].status = 'delivered';
  db.orders[orderIdx].delivered_at = new Date().toISOString();
  // If it was never marked paid (cash on delivery), keep delivered as final ops state
  await writeDB(db);
  const { proof_token, ...safe } = db.orders[orderIdx];
  res.json(safe);
});

app.post('/api/orders/:id/cancel', requireNegocio, async (req, res) => {
  db = readDB();
  const orderIdx = db.orders.findIndex(o => o.id === Number(req.params.id) && o.ownerId === req.user.id);
  if (orderIdx === -1) return res.status(404).json({ error: 'Order not found' });
  const order = db.orders[orderIdx];
  if (order.status === 'cancelled') {
    return res.status(400).json({ error: 'El pedido ya está cancelado' });
  }
  if (order.status === 'delivered') {
    return res.status(400).json({ error: 'No se puede cancelar un pedido ya entregado' });
  }
  const reason = String((req.body && req.body.reason) || '').trim().slice(0, 500);
  if (!reason) return res.status(400).json({ error: 'Indica el motivo de cancelación' });

  // Restore stock for tracked products
  for (const line of order.items || []) {
    const idx = db.menus.findIndex(m => m.id === line.id && m.ownerId === req.user.id);
    if (idx !== -1 && typeof db.menus[idx].stock === 'number') {
      db.menus[idx].stock = Math.max(0, Number(db.menus[idx].stock) + Math.max(0, Number(line.qty || 0)));
      if (db.menus[idx].stock > 0) db.menus[idx].available = true;
    }
  }

  db.orders[orderIdx].status = 'cancelled';
  db.orders[orderIdx].cancel_reason = reason;
  db.orders[orderIdx].cancelled_at = new Date().toISOString();
  ensureCashReversalForOrder(db, db.orders[orderIdx], reason);
  await writeDB(db);
  const { proof_token, ...safe } = db.orders[orderIdx];
  res.json(safe);
});

app.post('/api/orders/:id/proof', async (req, res) => {
  db = readDB();
  const id = Number(req.params.id);
  const orderIdx = db.orders.findIndex(o => o.id === id);
  if (orderIdx === -1) return res.status(404).json({ error: 'Order not found' });
  const token = (req.body && req.body.token) || req.query.token;
  const order = db.orders[orderIdx];
  if (!order.proof_token || !token || token !== order.proof_token) {
    return res.status(401).json({ error: 'Invalid or missing proof token' });
  }
  const proof_url = req.body.proof_url || null;
  if (proof_url && !/^https?:\/\//i.test(proof_url)) {
    return res.status(400).json({ error: 'proof_url must be http(s)' });
  }
  db.orders[orderIdx].proof_url = proof_url;
  db.orders[orderIdx].proof_submitted_at = new Date().toISOString();
  await writeDB(db);
  res.json({ ok: true, id: order.id, status: order.status, proof_submitted_at: db.orders[orderIdx].proof_submitted_at });
});

module.exports = app;
if (require.main === module) {
  const port = process.env.PORT || 4000;
  app.listen(port, () => console.log('Backend listening on', port));
}
