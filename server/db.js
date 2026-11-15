import fs from 'node:fs';
import path from 'node:path';
import { seedProducts } from './seed.js';

const SCHEMA = 2;
const empty = () => ({ version: SCHEMA, products: [], users: [], orders: [], subscribers: [], requests: [], outbox: [] });

// A small JSON-file store. The app runs as one process, every change is synchronous
// and is written to disk atomically (write a temp file, then rename over the old one).
export function createDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'db.json');
  let data = empty();
  if (fs.existsSync(file)) {
    const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Older demo data used a different shape. Keep a copy and start clean.
    if (loaded.version === SCHEMA) data = { ...empty(), ...loaded };
    else fs.renameSync(file, path.join(dataDir, `db.v${loaded.version || 1}.backup.json`));
  }
  if (data.products.length === 0) data.products = structuredClone(seedProducts);

  function save() {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }
  save();

  return {
    get data() { return data; },
    save,
    product: (id) => data.products.find((x) => x.id === id),
    order: (id) => data.orders.find((x) => x.id === id),
    user: (id) => data.users.find((x) => x.id === id),
    users: (role) => data.users.filter((x) => x.role === role)
  };
}
