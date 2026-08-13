const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  legacyId: { type: Number, index: true },
  username: { type: String, unique: true, required: true },
  role: String,
  salt: String,
  hash: String,
  email: { type: String, index: true, sparse: true },
  emailVerified: { type: Boolean, default: true },
  googleId: { type: String, index: true, sparse: true },
  authProvider: { type: String, default: 'local' },
  confirmToken: String,
  confirmCode: String,
  confirmExpires: Date,
  business: Object
}, { timestamps: true });

const menuSchema = new mongoose.Schema({
  legacyId: Number,
  legacyOwnerId: Number,
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true, sparse: true },
  name: String,
  description: String,
  price: Number,
  stock: Number,
  category: String,
  unit: String,
  available: Boolean,
  image: String
}, { timestamps: true });

const orderSchema = new mongoose.Schema({
  legacyId: Number,
  legacyOwnerId: Number,
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true, sparse: true },
  customer_name: String,
  customer_phone: String,
  customer_address: String,
  customer_notes: String,
  items: Array,
  total: Number,
  status: String,
  proof_url: String,
  proof_token: String,
  created_at: Date,
  paid_at: Date,
  proof_submitted_at: Date,
  dispatched_at: Date,
  delivered_at: Date,
  cancelled_at: Date,
  cancel_reason: String,
  payment_method: String
}, { timestamps: true });

const invSchema = new mongoose.Schema({
  legacyId: Number,
  legacyOwnerId: Number,
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  name: String,
  qty: Number,
  unit: String
}, { timestamps: true });

const cashSchema = new mongoose.Schema({
  legacyId: Number,
  legacyOwnerId: Number,
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  type: String,
  amount: Number,
  note: String,
  orderId: Number,
  created_at: Date
}, { timestamps: true });

const User = mongoose.models.User || mongoose.model('User', userSchema);
const Menu = mongoose.models.Menu || mongoose.model('Menu', menuSchema);
const Order = mongoose.models.Order || mongoose.model('Order', orderSchema);
const Inventory = mongoose.models.Inventory || mongoose.model('Inventory', invSchema);
const Cash = mongoose.models.Cash || mongoose.model('Cash', cashSchema);

module.exports = { mongoose, User, Menu, Order, Inventory, Cash };