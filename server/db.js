import fs from 'node:fs';
import path from 'node:path';
import { seedProducts } from './seed.js';

// The app keeps all data in memory and persists every change.
//   MONGODB_URI set: MongoDB (for example a free MongoDB Atlas cluster). Each collection below is a
//                    MongoDB collection; only documents that changed are written.
//   otherwise:       one JSON file in dataDir (local development and tests).
// Run a single app instance per database: the in-memory copy is the working state.

const SCHEMA = 2;
const COLLECTIONS = ['products', 'users', 'orders', 'subscribers', 'requests', 'outbox'];
const empty = () => ({ version: SCHEMA, products: [], users: [], orders: [], subscribers: [], requests: [], outbox: [] });

function accessors(data, save, flush, close, kind) {
  return {
    kind,
    get data() { return data; },
    save, flush, close,
    product: (id) => data.products.find((x) => x.id === id),
    order: (id) => data.orders.find((x) => x.id === id),
    user: (id) => data.users.find((x) => x.id === id),
    users: (role) => data.users.filter((x) => x.role === role)
  };
}

function withIds(data) {
  // Every stored document needs a stable id; older outbox entries did not have one.
  let n = 0;
  for (const m of data.outbox) if (!m.id) m.id = `mail-${Date.now().toString(36)}-${n++}`;
}

async function createFileDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'db.json');
  let data = empty();
  if (fs.existsSync(file)) {
    const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (loaded.version === SCHEMA) data = { ...empty(), ...loaded };
    else fs.renameSync(file, path.join(dataDir, `db.v${loaded.version || 1}.backup.json`));
  }
  if (data.products.length === 0) data.products = structuredClone(seedProducts);
  withIds(data);
  const save = () => {
    withIds(data);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  };
  save();
  return accessors(data, save, async () => {}, async () => {}, 'file');
}

async function createMongoDb(uri, dbName) {
  const { MongoClient } = await import('mongodb');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
  await client.connect();
  const mdb = client.db(dbName || undefined);
  const data = empty();
  const lastSaved = Object.fromEntries(COLLECTIONS.map((c) => [c, new Map()]));

  for (const c of COLLECTIONS) {
    const docs = await mdb.collection(c).find({}).toArray();
    for (const d of docs) {
      const { _id, ...doc } = d;
      data[c].push(doc);
      lastSaved[c].set(doc.id, JSON.stringify(doc));
    }
  }
  if (data.products.length === 0) data.products = structuredClone(seedProducts);
  await mdb.collection('users').createIndex({ role: 1, phone: 1 }, { unique: true }).catch(() => {});

  // Writes are queued and run one after another, so they reach MongoDB in order.
  let queue = Promise.resolve();
  let pending = false;
  const writeChanges = async () => {
    pending = false;
    withIds(data);
    for (const c of COLLECTIONS) {
      const seen = new Set();
      const ops = [];
      for (const doc of data[c]) {
        seen.add(doc.id);
        const json = JSON.stringify(doc);
        if (lastSaved[c].get(doc.id) !== json) {
          ops.push({ replaceOne: { filter: { _id: doc.id }, replacement: { _id: doc.id, ...JSON.parse(json) }, upsert: true } });
          lastSaved[c].set(doc.id, json);
        }
      }
      for (const id of [...lastSaved[c].keys()]) {
        if (!seen.has(id)) { ops.push({ deleteOne: { filter: { _id: id } } }); lastSaved[c].delete(id); }
      }
      if (ops.length) await mdb.collection(c).bulkWrite(ops, { ordered: true });
    }
  };
  const save = () => {
    if (pending) return;
    pending = true;
    queue = queue.then(() => new Promise((r) => setImmediate(r))).then(writeChanges).catch((err) => { console.error('Database write failed:', err.message); });
  };
  const flush = async () => { save(); await queue; };
  save();
  await queue;
  return accessors(data, save, flush, async () => { await flush(); await client.close(); }, 'mongodb');
}

export async function createDb({ dataDir, mongoUri, mongoDbName }) {
  return mongoUri ? createMongoDb(mongoUri, mongoDbName) : createFileDb(dataDir);
}
