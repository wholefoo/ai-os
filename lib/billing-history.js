'use strict';
const { DatabaseSync } = require('node:sqlite');
const stores = new Map();
function openBillingHistory(filename) {
  if (stores.has(filename)) return stores.get(filename);
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS fulfilled (id TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS cancelled (id TEXT PRIMARY KEY);');
  const store = {
    fulfilled: id => !!db.prepare('SELECT id FROM fulfilled WHERE id=?').get(id),
    cancelled: id => !!id && !!db.prepare('SELECT id FROM cancelled WHERE id=?').get(id),
    recordFulfillment: id => db.prepare('INSERT OR IGNORE INTO fulfilled(id) VALUES (?)').run(id),
    recordCancellation: id => db.prepare('INSERT OR IGNORE INTO cancelled(id) VALUES (?)').run(id),
    close: () => { db.close(); stores.delete(filename); },
  };
  stores.set(filename, store);
  return store;
}
module.exports = { openBillingHistory };
