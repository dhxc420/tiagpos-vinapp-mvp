const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(express.json({ limit: '8mb' }));
// serve frontend static files
app.use(express.static(path.join(__dirname, '../frontend')));

// On serverless platforms (Vercel) the deployment directory is read-only;
// only /tmp is writable, so keep mutable data there.
const IS_SERVERLESS = !!process.env.VERCEL || !!process.env.AWS_LAMBDA_FUNCTION_NAME;
const DATA_DIR = IS_SERVERLESS ? '/tmp' : __dirname;

// serve uploaded images from /uploads
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
if(!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOAD_DIR));

const DB_FILE = path.join(DATA_DIR, 'db.json');
// seed the writable DB on first (cold) start from a bundled db.json or db.sample.json
if(!fs.existsSync(DB_FILE)){
  const seedCandidates = [path.join(__dirname, 'db.json'), path.join(__dirname, 'db.sample.json')];
  const seed = seedCandidates.find(p => p !== DB_FILE && fs.existsSync(p));
  if(seed){
    try{ fs.copyFileSync(seed, DB_FILE); }catch(e){ console.warn('Could not seed db.json:', e.message); }
  }
}

// Adapter: file DB with optional Mongo sync
let usingMongo = false;
let mongoModels = null;

async function initMongoIfConfigured(){
  const mongoUri = process.env.MONGO_URI || process.env.MONGOURL || process.env.MONGOURL_SHORT;
  if(!mongoUri) return;
  try{
    mongoModels = require('./mongo_models');
    await mongoModels.mongoose.connect(mongoUri);
    usingMongo = true;
    console.log('Connected to MongoDB via MONGO_URI');
    // load data from mongo into in-memory db shape
    const users = await mongoModels.User.find({}).lean();
    const menus = await mongoModels.Menu.find({}).lean();
    const orders = await mongoModels.Order.find({}).lean();
    const inventories = await mongoModels.Inventory.find({}).lean();
    const cash = await mongoModels.Cash.find({}).lean();

    // map mongo docs to legacy format
    const dbFromMongo = {
      menus: (menus || []).map(m=> ({ id: m.legacyId || 0, ownerId: m.legacyOwnerId || null, name: m.name, price: m.price, available: m.available })),
      orders: (orders || []).map(o=> ({ id: o.legacyId || 0, ownerId: o.legacyOwnerId || null, customer_name: o.customer_name, customer_phone: o.customer_phone, items: o.items, total: o.total, status: o.status, proof_url: o.proof_url, created_at: o.created_at, paid_at: o.paid_at })),
      users: (users || []).map(u=> ({ id: u.legacyId || 0, username: u.username, salt: u.salt, hash: u.hash, role: u.role, business: u.business })),
      inventories: (inventories || []).map(i=> ({ id: i.legacyId || 0, ownerId: i.legacyOwnerId || null, name: i.name, qty: i.qty, unit: i.unit })),
      cash: (cash || []).map(c=> ({ id: c.legacyId || 0, ownerId: c.legacyOwnerId || null, type: c.type, amount: c.amount, note: c.note, created_at: c.created_at }))
    };

    // populate last ids
    dbFromMongo.lastMenuId = dbFromMongo.menus.length ? Math.max(...dbFromMongo.menus.map(m=>m.id||0)) : 0;
    dbFromMongo.lastOrderId = dbFromMongo.orders.length ? Math.max(...dbFromMongo.orders.map(o=>o.id||0)) : 0;
    dbFromMongo.lastUserId = dbFromMongo.users.length ? Math.max(...dbFromMongo.users.map(u=>u.id||0)) : 0;
    dbFromMongo.lastInventoryId = dbFromMongo.inventories.length ? Math.max(...dbFromMongo.inventories.map(i=>i.id||0)) : 0;
    dbFromMongo.lastCashId = dbFromMongo.cash.length ? Math.max(...dbFromMongo.cash.map(c=>c.id||0)) : 0;

    // write a local backup file if not present
    if(!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify(dbFromMongo, null, 2));

    return dbFromMongo;

  }catch(e){
    console.warn('Mongo init failed, falling back to file DB:', e.message);
    return null;
  }
}

function readDB(){
  const defaultSeed = {
    menus: [
      { id: 1, name: 'Pizza Margarita', price: 25000, available: true },
      { id: 2, name: 'Hamburguesa Clasica', price: 18000, available: true },
      { id: 3, name: 'Ensalada Cesar', price: 12000, available: true }
    ],
    orders: [],
    users: [],
    inventories: [],
    cash: [],
    lastMenuId: 3,
    lastOrderId: 0,
    lastUserId: 0,
    lastInventoryId: 0,
    lastCashId: 0
  };

  if(!fs.existsSync(DB_FILE)){
    fs.writeFileSync(DB_FILE, JSON.stringify(defaultSeed, null, 2));
    return defaultSeed;
  }

  try{
    const db = JSON.parse(fs.readFileSync(DB_FILE));
    db.menus = Array.isArray(db.menus) ? db.menus : defaultSeed.menus.slice();
    db.orders = Array.isArray(db.orders) ? db.orders : [];
    db.users = Array.isArray(db.users) ? db.users : [];
    db.inventories = Array.isArray(db.inventories) ? db.inventories : [];
    db.cash = Array.isArray(db.cash) ? db.cash : [];
    db.lastMenuId = Number.isFinite(db.lastMenuId) ? db.lastMenuId : (db.menus.length ? Math.max(...db.menus.map(m=>m.id)) : defaultSeed.lastMenuId);
    db.lastOrderId = Number.isFinite(db.lastOrderId) ? db.lastOrderId : (db.orders.length ? Math.max(...db.orders.map(o=>o.id)) : defaultSeed.lastOrderId);
    db.lastUserId = Number.isFinite(db.lastUserId) ? db.lastUserId : (db.users.length ? Math.max(...db.users.map(u=>u.id)) : defaultSeed.lastUserId);
    db.lastInventoryId = Number.isFinite(db.lastInventoryId) ? db.lastInventoryId : (db.inventories.length ? Math.max(...db.inventories.map(i=>i.id)) : defaultSeed.lastInventoryId);
    db.lastCashId = Number.isFinite(db.lastCashId) ? db.lastCashId : (db.cash.length ? Math.max(...db.cash.map(c=>c.id)) : defaultSeed.lastCashId);
    return db;
  }catch(err){
    fs.writeFileSync(DB_FILE, JSON.stringify(defaultSeed, null, 2));
    return defaultSeed;
  }
}

function writeDB(db){
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  // if using Mongo, sync changed arrays to Mongo collections (upsert by legacyId)
  if(usingMongo && mongoModels){
    // users
    (async ()=>{
      try{
        for(const u of db.users || []){
          const filter = { legacyId: u.id };
          const update = { $set: { legacyId: u.id, username: u.username, role: u.role, salt: u.salt, hash: u.hash, business: u.business || null } };
          await mongoModels.User.updateOne(filter, update, { upsert: true });
        }
        // menus
        for(const m of db.menus || []){
          const filter = { legacyId: m.id };
          const update = { $set: { legacyId: m.id, legacyOwnerId: m.ownerId || null, name: m.name, price: m.price, available: !!m.available } };
          await mongoModels.Menu.updateOne(filter, update, { upsert: true });
        }
        // orders
        for(const o of db.orders || []){
          const filter = { legacyId: o.id };
          const update = { $set: { legacyId: o.id, legacyOwnerId: o.ownerId || null, customer_name: o.customer_name, customer_phone: o.customer_phone || null, items: o.items || [], total: o.total || 0, status: o.status || 'pending', proof_url: o.proof_url || null, created_at: o.created_at ? new Date(o.created_at) : new Date(), paid_at: o.paid_at ? new Date(o.paid_at) : null } };
          await mongoModels.Order.updateOne(filter, update, { upsert: true });
        }
        // inventories
        for(const i of db.inventories || []){
          const filter = { legacyId: i.id };
          const update = { $set: { legacyId: i.id, legacyOwnerId: i.ownerId || null, name: i.name, qty: i.qty || 0, unit: i.unit || '' } };
          await mongoModels.Inventory.updateOne(filter, update, { upsert: true });
        }
        // cash
        for(const c of db.cash || []){
          const filter = { legacyId: c.id };
          const update = { $set: { legacyId: c.id, legacyOwnerId: c.ownerId || null, type: c.type, amount: c.amount, note: c.note || '', created_at: c.created_at ? new Date(c.created_at) : new Date() } };
          await mongoModels.Cash.updateOne(filter, update, { upsert: true });
        }
      }catch(e){ console.warn('Error syncing to Mongo:', e.message); }
    })();
  }
}

// initialize DB file and optionally load mongo
let db = readDB();

const crypto = require('crypto');

// If MONGO_URI is present, initialize mongo and replace in-memory db with mongo-loaded data
(async ()=>{
  const maybe = await initMongoIfConfigured();
  if(maybe){ db = maybe; }
})();

app.get('/api/health', (req,res)=>res.json({ok:true}));

// password hashing helpers (pbkdf2)
function hashPassword(password, salt){
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash){
  const h = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return h === hash;
}

// ensure admin user exists from env
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

function ensureAdmin(){
  db = readDB();
  const existing = db.users.find(u=>u.username === ADMIN_USER);
  if(!existing){
    const { salt, hash } = hashPassword(ADMIN_PASS);
    const user = { id: ++db.lastUserId, username: ADMIN_USER, salt, hash, role: 'negocio' };
    db.users.push(user);
    writeDB(db);
    console.log('Admin user created:', ADMIN_USER);
  }
}
ensureAdmin();

// ensure existing businesses have slugs (migration)
function ensureBusinessSlugs(){
  db = readDB();
  const used = new Set(db.users.filter(u=>u.business && u.business.slug).map(u=>u.business.slug));
  let changed = false;
  db.users.forEach(u=>{
    if(u.business && !u.business.slug){
      const base = (u.business.name || u.username || 'biz').toString().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'');
      let slug = base || ('biz-'+u.id);
      if(used.has(slug)) slug = slug + '-' + u.id;
      u.business.slug = slug; used.add(slug); changed = true;
    }
  });
  if(changed) writeDB(db);
}
ensureBusinessSlugs();

const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

function createToken(userId){
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '12h' });
}
function validateToken(token){
  if(!token) return false;
  try{
    const payload = jwt.verify(token, JWT_SECRET);
    return payload; // { userId, iat, exp }
  }catch(e){ return false; }
}

function requireAuth(req,res,next){
  const h = req.headers['authorization'] || '';
  const parts = h.split(' ');
  if(parts.length===2 && parts[0] === 'Bearer'){
    const payload = validateToken(parts[1]);
    if(payload){ req.token = parts[1]; req.userId = payload.userId; return next(); }
  }
  return res.status(401).json({ error: 'Unauthorized' });
}

function requireNegocio(req,res,next){
  const h = req.headers['authorization'] || '';
  const parts = h.split(' ');
  if(parts.length !== 2 || parts[0] !== 'Bearer'){
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const payload = validateToken(parts[1]);
  if(!payload) return res.status(401).json({ error: 'Unauthorized' });
  req.token = parts[1];
  const userId = payload.userId;
  db = readDB();
  const user = db.users.find(u => u.id === userId);
  if(!user || user.role !== 'negocio') return res.status(403).json({ error: 'Forbidden' });
  req.user = { id: user.id, username: user.username, role: user.role, business: user.business || {} };
  next();
}

app.post('/api/login', (req,res)=>{
  const { username, password } = req.body || {};
  if(!username || !password) return res.status(400).json({ error: 'username and password required' });
  db = readDB();
  const user = db.users.find(u=>u.username === username);
  if(user && verifyPassword(password, user.salt, user.hash)){
    const token = createToken(user.id);
    return res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
  }
  return res.status(401).json({ error:'Invalid credentials' });
});

// register endpoint
app.post('/api/register', (req,res)=>{
  const { username, password, role, business } = req.body || {};
  if(!username || !password || !role) return res.status(400).json({ error: 'username, password and role required' });
  if(!['cliente','negocio'].includes(role)) return res.status(400).json({ error: 'role must be cliente or negocio' });
  db = readDB();
  if(db.users.find(u=>u.username === username)) return res.status(400).json({ error: 'username already exists' });
  const { salt, hash } = hashPassword(password);
  const user = { id: ++db.lastUserId, username, salt, hash, role };
  if(role === 'negocio' && business && typeof business === 'object'){
    // store business metadata
    user.business = {
      name: business.name || '',
      email: business.email || '',
      phone: business.phone || '',
      address: business.address || ''
    };
    // create a slug for public url
    const slugBase = (business.name || username || 'biz').toString().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'');
    let slug = slugBase || (`biz-${user.id}`);
    // ensure uniqueness
    const used = new Set(db.users.filter(u=>u.business && u.business.slug).map(u=>u.business.slug));
    if(used.has(slug)) slug = slug + '-' + (user.id);
    user.business.slug = slug;
  }
  db.users.push(user);
  writeDB(db);
  const token = createToken(user.id);
  const userOut = { id: user.id, username: user.username, role: user.role };
  if(user.business) userOut.business = user.business;
  res.json({ token, user: userOut });
});

app.get('/api/me', requireAuth, (req,res)=>{
  const userId = req.userId;
  db = readDB();
  const user = db.users.find(u => u.id === userId);
  if(!user) return res.status(401).json({ error: 'Unauthorized' });
  const userOut = { id: user.id, username: user.username, role: user.role };
  if(user.business) userOut.business = user.business;
  // expose logo URL if present
  if(user.business && user.business.logo) userOut.business.logo = user.business.logo;
  // include slug for negocio
  if(user.business && user.business.slug) userOut.business.slug = user.business.slug;
  res.json(userOut);
});

// update business/profile
app.put('/api/me', requireAuth, (req,res)=>{
  const userId = req.userId;
  db = readDB();
  const user = db.users.find(u => u.id === userId);
  if(!user) return res.status(401).json({ error: 'Unauthorized' });
  const { business } = req.body || {};
  if(business && typeof business === 'object'){
    user.business = user.business || {};
    ['name','email','phone','address'].forEach(k=>{ if(typeof business[k] !== 'undefined') user.business[k] = business[k]; });
    writeDB(db);
    const userOut = { id: user.id, username: user.username, role: user.role, business: user.business };
    return res.json(userOut);
  }
  return res.status(400).json({ error: 'business object required' });
});

// upload avatar as data URL
app.post('/api/me/avatar', requireAuth, (req,res)=>{
  const userId = req.userId;
  db = readDB();
  const user = db.users.find(u => u.id === userId);
  if(!user) return res.status(401).json({ error: 'Unauthorized' });
  const { image } = req.body || {};
  if(!image || typeof image !== 'string') return res.status(400).json({ error: 'image data required' });
  // image expected as data:<mime>;base64,<data>
  const m = image.match(/^data:(image\/(png|jpeg|jpg|webp));base64,(.+)$/);
  if(!m) return res.status(400).json({ error: 'invalid image data' });
  const mime = m[1];
  const ext = m[2] === 'jpeg' ? 'jpg' : m[2];
  const b64 = m[3];
  const buffer = Buffer.from(b64, 'base64');
  const filename = `${user.id}_${Date.now()}.${ext}`;
  const filepath = path.join(UPLOAD_DIR, filename);
  fs.writeFileSync(filepath, buffer);
  user.business = user.business || {};
  user.business.logo = `/uploads/${filename}`;
  writeDB(db);
  res.json({ url: user.business.logo });
});

// simple config endpoint: set WHATSAPP_NUMBER and CHECKOUT_BASE as env vars if desired
// build a default checkout URL from the incoming request host (works locally and on Vercel)
function defaultCheckoutBase(req){
  const host = req.get('host') || 'localhost:4000';
  const proto = req.protocol || 'http';
  return `${proto}://${host}/checkout.html`;
}

app.get('/api/config', (req,res)=>{
  const whatsapp_number = process.env.WHATSAPP_NUMBER || '573001234567'; // e.g. country code + number, no + sign
  const checkout_base = process.env.CHECKOUT_BASE || defaultCheckoutBase(req);
  res.json({ whatsapp_number, checkout_base });
});

// GET menu - supports optional ?ownerSlug=slug to retrieve business-specific menus
app.get('/api/menu', (req,res)=>{
  const ownerSlug = req.query.ownerSlug;
  db = readDB();
  if(ownerSlug){
    const owner = db.users.find(u=> u.business && u.business.slug === ownerSlug);
    if(!owner) return res.status(404).json({ error: 'Business not found' });
    // return items owned by this business; if none, fall back to global (ownerId null)
    const items = db.menus.filter(m => m.ownerId === owner.id);
    if(items.length) return res.json(items);
    return res.json(db.menus.filter(m=> !m.ownerId));
  }
  // if auth negocio requesting without query, return only their items
  const authHeader = (req.headers['authorization']||'').split(' ');
  if(authHeader.length===2 && authHeader[0]==='Bearer'){
    const payload = validateToken(authHeader[1]);
    if(payload){
      const user = db.users.find(u=>u.id===payload.userId);
      if(user && user.role === 'negocio'){
        return res.json(db.menus.filter(m=> m.ownerId === user.id));
      }
    }
  }
  // default: return global menus
  res.json(db.menus.filter(m=> !m.ownerId));
});

// Menu management for negocio
app.get('/api/menu/my', requireNegocio, (req,res)=>{
  db = readDB();
  const items = db.menus.filter(m=> m.ownerId === req.user.id);
  res.json(items);
});
app.post('/api/menu', requireNegocio, (req,res)=>{
  const { name, price, available } = req.body || {};
  if(!name) return res.status(400).json({ error: 'name required' });
  db = readDB();
  const item = { id: ++db.lastMenuId, ownerId: req.user.id, name, price: Number(price||0), available: !!available };
  db.menus.push(item);
  writeDB(db);
  res.json(item);
});
app.put('/api/menu/:id', requireNegocio, (req,res)=>{
  const id = Number(req.params.id);
  db = readDB();
  const idx = db.menus.findIndex(m=> m.id === id && m.ownerId === req.user.id);
  if(idx === -1) return res.status(404).json({ error: 'Menu item not found' });
  const body = req.body || {};
  ['name','price','available'].forEach(k=>{ if(typeof body[k] !== 'undefined') db.menus[idx][k] = body[k]; });
  writeDB(db);
  res.json(db.menus[idx]);
});
app.delete('/api/menu/:id', requireNegocio, (req,res)=>{
  const id = Number(req.params.id);
  db = readDB();
  const idx = db.menus.findIndex(m=> m.id === id && m.ownerId === req.user.id);
  if(idx === -1) return res.status(404).json({ error: 'Menu item not found' });
  const removed = db.menus.splice(idx,1)[0];
  writeDB(db);
  res.json(removed);
});

// Public business info by slug (API)
app.get('/api/b/:slug', (req,res)=>{
  const slug = req.params.slug;
  db = readDB();
  const user = db.users.find(u=> u.business && u.business.slug === slug);
  if(!user) return res.status(404).json({ error: 'Business not found' });
  const b = Object.assign({}, user.business);
  // hide internal fields
  delete b.slug; // keep internal if desired, but public API can omit
  res.json({ username: user.username, business: b });
});

// Public route serving business page
app.get('/b/:slug', (req,res)=>{
  // serve frontend/business.html (must exist)
  res.sendFile(path.join(__dirname, '../frontend/business.html'));
});

app.post('/api/orders', (req,res)=>{
  const { customer_name, customer_phone, items, ownerSlug } = req.body || {};
  if(!items || !Array.isArray(items)) return res.status(400).json({error:'items array required'});
  db = readDB();
  // if ownerSlug provided, try to find owner
  let ownerId = null;
  if(ownerSlug){
    const owner = db.users.find(u => u.business && u.business.slug === ownerSlug);
    if(owner) ownerId = owner.id;
  }
  const total = items.reduce((s,i)=>s + (i.price || 0) * (i.qty||1),0);
  const order = {
    id: ++db.lastOrderId,
    ownerId: ownerId, // may be null for anonymous orders
    customer_name: customer_name || 'Anon',
    customer_phone: customer_phone || null,
    items: items,
    total: total,
    status: 'pending',
    created_at: new Date().toISOString()
  };
  db.orders.unshift(order);
  writeDB(db);

  // include a checkout_url if CHECKOUT_BASE is configured
  let checkout_base = process.env.CHECKOUT_BASE || defaultCheckoutBase(req);
  try{
    const u = new URL(checkout_base);
    if (u.pathname.endsWith('/checkout')) u.pathname = u.pathname + '.html';
    if (u.pathname === '/' || u.pathname === '') u.pathname = '/checkout.html';
    checkout_base = u.toString().replace(/#.*$/,'');
  }catch(e){
    if(checkout_base.endsWith('/checkout')) checkout_base = checkout_base + '.html';
    if(checkout_base.endsWith('/')) checkout_base = checkout_base + 'checkout.html';
  }
  const checkout_url = `${checkout_base}${checkout_base.includes('?') ? '&' : '?'}orderId=${order.id}&total=${order.total}`;

  res.json({...order, checkout_url});
});

app.get('/api/orders', requireNegocio, (req,res)=>{
  db = readDB();
  // return only orders that belong to the authenticated negocio
  const items = db.orders.filter(o => o.ownerId === req.user.id).slice(0,50);
  res.json(items);
});

// Inventory endpoints (per negocio)
app.get('/api/inventory', requireNegocio, (req,res)=>{
  db = readDB();
  // inventory items scoped to user id
  const items = db.inventories.filter(i=> i.ownerId === req.user.id);
  res.json(items);
});

app.post('/api/inventory', requireNegocio, (req,res)=>{
  const { name, qty, unit } = req.body || {};
  if(!name) return res.status(400).json({ error: 'name required' });
  db = readDB();
  const item = { id: ++db.lastInventoryId, ownerId: req.user.id, name, qty: Number(qty||0), unit: unit || '' };
  db.inventories.push(item);
  writeDB(db);
  res.json(item);
});

app.put('/api/inventory/:id', requireNegocio, (req,res)=>{
  const id = Number(req.params.id);
  db = readDB();
  const idx = db.inventories.findIndex(i=>i.id===id && i.ownerId===req.user.id);
  if(idx===-1) return res.status(404).json({ error: 'Item not found' });
  const body = req.body || {};
  ['name','qty','unit'].forEach(k=>{ if(typeof body[k] !== 'undefined') db.inventories[idx][k] = body[k]; });
  writeDB(db);
  res.json(db.inventories[idx]);
});

app.delete('/api/inventory/:id', requireNegocio, (req,res)=>{
  const id = Number(req.params.id);
  db = readDB();
  const idx = db.inventories.findIndex(i=>i.id===id && i.ownerId===req.user.id);
  if(idx===-1) return res.status(404).json({ error: 'Item not found' });
  const removed = db.inventories.splice(idx,1)[0];
  writeDB(db);
  res.json(removed);
});

// Cash movements endpoints
app.get('/api/cash', requireNegocio, (req,res)=>{
  db = readDB();
  const items = db.cash.filter(c=> c.ownerId === req.user.id);
  res.json(items);
});

app.post('/api/cash', requireNegocio, (req,res)=>{
  const { type, amount, note } = req.body || {};
  if(!type || typeof amount === 'undefined') return res.status(400).json({ error: 'type and amount required' });
  db = readDB();
  const mv = { id: ++db.lastCashId, ownerId: req.user.id, type, amount: Number(amount), note: note || '', created_at: new Date().toISOString() };
  db.cash.push(mv);
  writeDB(db);
  res.json(mv);
});

app.get('/api/orders/:id', requireNegocio, (req,res)=>{
  db = readDB();
  const id = Number(req.params.id);
  const order = db.orders.find(o=>o.id === id && o.ownerId === req.user.id);
  if(!order) return res.status(404).json({ error: 'Order not found' });
  res.json(order);
});

app.post('/api/orders/:id/confirm-payment', requireNegocio, (req,res)=>{
  db = readDB();
  const id = Number(req.params.id);
  const orderIdx = db.orders.findIndex(o=>o.id === id && o.ownerId === req.user.id);
  if(orderIdx === -1) return res.status(404).json({ error: 'Order not found' });
  const proof_url = req.body.proof_url || null;
  db.orders[orderIdx].status = 'paid';
  db.orders[orderIdx].proof_url = proof_url;
  db.orders[orderIdx].paid_at = new Date().toISOString();
  writeDB(db);
  res.json(db.orders[orderIdx]);
});

app.post('/api/orders/:id/proof', (req,res)=>{
  db = readDB();
  const id = Number(req.params.id);
  const orderIdx = db.orders.findIndex(o=>o.id === id);
  if(orderIdx === -1) return res.status(404).json({ error: 'Order not found' });
  const proof_url = req.body.proof_url || null;
  db.orders[orderIdx].proof_url = proof_url;
  db.orders[orderIdx].proof_submitted_at = new Date().toISOString();
  writeDB(db);
  res.json(db.orders[orderIdx]);
});

module.exports = app;
if(require.main === module){
  const port = process.env.PORT || 4000;
  app.listen(port, ()=>console.log('Backend (file-db) listening on',port));
}
