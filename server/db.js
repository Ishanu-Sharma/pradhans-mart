import fs from 'node:fs';
import path from 'node:path';
import { seedProducts } from './seed.js';

const empty = () => ({ products: [], orders: [], riders: [], subscribers: [], requests: [], outbox: [] });

// A small JSON-file store. The app runs as one process, every change is synchronous
// and is written to disk atomically (write a temp file, then rename over the old one).
export function createDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'db.json');
  let data = empty();
  if (fs.existsSync(file)) {
    data = { ...empty(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  }
  if (data.products.length === 0) {
    data.products = structuredClone(seedProducts);
  }

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
    rider: (id) => data.riders.find((x) => x.id === id)
  };
}
