/**
 * Fills in Hindi copy for services that do not have it yet.
 *
 *   node src/scripts/backfill-hindi.js            dry run: shows what would change
 *   node src/scripts/backfill-hindi.js --apply    writes it
 *
 * Only ever fills an EMPTY Hindi field. Prices, English names and anything an
 * admin has already written in Hindi are never touched, so it is safe to run
 * against the live database, and safe to run twice.
 */
import '../lib/env.js';
import mongoose from 'mongoose';
import { Service } from '../models/index.js';
import { HINDI_CATALOG } from './hindiCatalog.js';

const apply = process.argv.includes('--apply');
await mongoose.connect(process.env.MONGO_URI);

let changed = 0;
for (const [code, hindi] of Object.entries(HINDI_CATALOG)) {
  const service = await Service.findOne({ code });
  if (!service) continue;

  const set = {};
  for (const [field, value] of Object.entries(hindi)) {
    const current = service[field];
    const empty = Array.isArray(current) ? current.length === 0 : !current;
    if (empty) set[field] = value;
  }
  if (!Object.keys(set).length) {
    console.log(`  ${code.padEnd(10)} already has Hindi — left alone`);
    continue;
  }
  changed += 1;
  console.log(`  ${code.padEnd(10)} ${apply ? 'filled' : 'would fill'}: ${Object.keys(set).join(', ')}`);
  if (apply) await Service.updateOne({ _id: service._id }, { $set: set });
}

console.log(`\n${apply ? 'Updated' : 'Would update'} ${changed} service(s) in "${mongoose.connection.name}".${apply ? '' : ' Re-run with --apply to write.'}`);
await mongoose.disconnect();
