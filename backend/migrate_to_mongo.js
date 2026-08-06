// migrate_to_mongo.js
// Usage: node migrate_to_mongo.js "mongodb+srv://user:pass@host/db?options"
// If no URI passed as arg, the script will read process.env.MONGO_URI

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

async function main(){
  const uri = process.argv[2] || process.env.MONGO_URI;
  if(!uri){
    console.error('MongoDB URI required as argument or in MONGO_URI environment variable');
    process.exit(2);
  }

  const dbFile = path.join(__dirname, 'db.json');
  if(!fs.existsSync(dbFile)){
    console.error('db.json not found at', dbFile);
    process.exit(2);
  }

  const raw = JSON.parse(fs.readFileSync(dbFile));

  // connect
  await mongoose.connect(uri);
  console.log('Connected to MongoDB');

  // define simple schemas
  const userSchema = new mongoose.Schema({
    legacyId: { type: Number, index: true },
    username: { type: String, unique: true, required: true },
    role: String,
    salt: String,
    hash: String,
    business: Object
  }, { timestamps: true });

  const menuSchema = new mongoose.Schema({
    legacyId: Number,
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true, sparse: true },
    legacyOwnerId: Number,
    name: String,
    price: Number,
    available: Boolean
  }, { timestamps: true });

  const orderSchema = new mongoose.Schema({
    legacyId: Number,
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true, sparse: true },
    legacyOwnerId: Number,
    customer_name: String,
    customer_phone: String,
    items: Array,
    total: Number,
    status: String,
    proof_url: String,
    created_at: Date,
    paid_at: Date
  }, { timestamps: true });

  const invSchema = new mongoose.Schema({
    legacyId: Number,
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    legacyOwnerId: Number,
    name: String,
    qty: Number,
    unit: String
  }, { timestamps: true });

  const cashSchema = new mongoose.Schema({
    legacyId: Number,
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    legacyOwnerId: Number,
    type: String,
    amount: Number,
    note: String,
    created_at: Date
  }, { timestamps: true });

  const User = mongoose.model('User', userSchema);
  const Menu = mongoose.model('Menu', menuSchema);
  const Order = mongoose.model('Order', orderSchema);
  const Inventory = mongoose.model('Inventory', invSchema);
  const Cash = mongoose.model('Cash', cashSchema);

  try{
    // Insert users first
    console.log('Importing users:', raw.users.length);
    const legacyUserMap = new Map(); // legacyId -> _id

    for(const u of raw.users || []){
      const doc = {
        legacyId: u.id,
        username: u.username,
        role: u.role,
        salt: u.salt,
        hash: u.hash,
        business: u.business || null
      };
      // upsert by username to avoid duplicates
      const existing = await User.findOne({ username: doc.username });
      if(existing){
        legacyUserMap.set(u.id, existing._id);
      } else {
        const created = await User.create(doc);
        legacyUserMap.set(u.id, created._id);
      }
    }

    // Indexes: ensure business.slug unique if present
    try{ await User.collection.createIndex({ 'business.slug': 1 }, { unique: true, sparse: true }); }catch(e){ console.warn('Could not create business.slug index:', e.message); }

    // Menus
    console.log('Importing menus:', raw.menus.length);
    for(const m of raw.menus || []){
      const legacyOwnerId = m.ownerId || null;
      const owner = legacyOwnerId ? legacyUserMap.get(legacyOwnerId) : null;
      const doc = { legacyId: m.id, legacyOwnerId, owner: owner || null, name: m.name, price: m.price, available: !!m.available };
      await Menu.create(doc);
    }

    // Orders
    console.log('Importing orders:', raw.orders.length);
    for(const o of raw.orders || []){
      const legacyOwnerId = o.ownerId || null;
      const owner = legacyOwnerId ? legacyUserMap.get(legacyOwnerId) : null;
      const doc = {
        legacyId: o.id,
        legacyOwnerId,
        owner: owner || null,
        customer_name: o.customer_name || o.customer || 'Anon',
        customer_phone: o.customer_phone || null,
        items: o.items || [],
        total: o.total || 0,
        status: o.status || 'pending',
        proof_url: o.proof_url || null,
        created_at: o.created_at ? new Date(o.created_at) : new Date(),
        paid_at: o.paid_at ? new Date(o.paid_at) : null
      };
      await Order.create(doc);
    }

    // Inventories
    console.log('Importing inventories:', raw.inventories.length);
    for(const i of raw.inventories || []){
      const legacyOwnerId = i.ownerId || null;
      const owner = legacyOwnerId ? legacyUserMap.get(legacyOwnerId) : null;
      const doc = { legacyId: i.id, legacyOwnerId, owner: owner || null, name: i.name, qty: i.qty || 0, unit: i.unit || '' };
      await Inventory.create(doc);
    }

    // Cash
    console.log('Importing cash items:', raw.cash.length);
    for(const c of raw.cash || []){
      const legacyOwnerId = c.ownerId || null;
      const owner = legacyOwnerId ? legacyUserMap.get(legacyOwnerId) : null;
      const doc = { legacyId: c.id, legacyOwnerId, owner: owner || null, type: c.type, amount: c.amount, note: c.note || '', created_at: c.created_at ? new Date(c.created_at) : new Date() };
      await Cash.create(doc);
    }

    console.log('Migration complete. Created records:');
    const uc = await User.countDocuments(); const mc = await Menu.countDocuments(); const oc = await Order.countDocuments();
    const ic = await Inventory.countDocuments(); const cc = await Cash.countDocuments();
    console.log('Users:', uc, 'Menus:', mc, 'Orders:', oc, 'Inventories:', ic, 'Cash:', cc);

  }catch(err){
    console.error('Migration error:', err);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
    process.exit(0);
  }
}

main();
