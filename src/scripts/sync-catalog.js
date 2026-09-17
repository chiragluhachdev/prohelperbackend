// Must be first: populates process.env from .env when running locally.
import '../lib/env.js';
/**
 * Adds the launch catalog to a database that already has services, without
 * undoing anything an admin has changed.
 *
 *   npm run catalog:sync            — show what would change
 *   npm run catalog:sync -- --apply — make the changes
 *
 *  - a service that does not exist yet is added, questions and all
 *  - an existing service keeps its name, price and copy; it only gains
 *    questions if it has none, so an admin's own questions are never replaced
 *  - "Bathroom Cleaning" becomes "Washroom Cleaning", if it still has its
 *    original name
 *  - Hindi copy left from when the apps had a second language is removed
 */
import mongoose from 'mongoose';
import { connectDb } from '../lib/db.js';
import { ensureSettings } from '../lib/settings.js';
import { Category, Service } from '../models/index.js';
import { CATALOG } from './catalog.js';
import { normaliseOptions } from '../lib/serviceOptions.js';

const APPLY = process.argv.includes('--apply');

async function run() {
  await connectDb();
  await ensureSettings(); // new pricing switches get their defaults
  const plan = [];

  for (const entry of CATALOG) {
    const options = normaliseOptions(entry.options || []);
    const existing = await Service.findOne({ code: entry.code }).lean();

    if (!existing) {
      plan.push([`add ${entry.code} (${entry.name}, ₹${entry.basePrice}, ${options.length} questions)`, () =>
        Service.create({ ...entry, options, optionsEnabled: options.length > 0 && entry.optionsEnabled !== false, active: true })]);
      continue;
    }

    const set = {};
    if (entry.code === 'bathroom' && existing.name === 'Bathroom Cleaning') {
      set.name = entry.name;
    }
    if (!(existing.options || []).length && options.length) {
      set.options = options;
      if (!existing.optionsEnabled && entry.optionsEnabled) set.optionsEnabled = true;
    }
    if (Object.keys(set).length) {
      plan.push([`update ${entry.code}: ${Object.keys(set).join(', ')}`, () => Service.updateOne({ code: entry.code }, { $set: set })]);
    }
  }

  /*
   * The apps are English only. Straight to the collections: the models no
   * longer know these fields, so Mongoose would drop them from an $unset.
   */
  const hindi = { nameHi: '', descriptionHi: '', durationLabelHi: '', inclusionsHi: '' };
  const hindiQuestion = { 'options.$[].labelHi': '', 'options.$[].helpHi': '', 'options.$[].placeholderHi': '', 'options.$[].choicesHi': '', 'options.$[].unitHi': '' };
  const hasHindi = {
    $or: [...Object.keys(hindi), ...Object.keys(hindiQuestion).map((k) => k.replace('.$[]', ''))].map((k) => ({ [k]: { $exists: true } })),
  };
  const servicesWithHindi = await Service.collection.countDocuments(hasHindi);
  if (servicesWithHindi) {
    plan.push([`remove Hindi copy from ${servicesWithHindi} services`, async () => {
      await Service.collection.updateMany({}, { $unset: hindi });
      await Service.collection.updateMany({ 'options.0': { $exists: true } }, { $unset: hindiQuestion });
    }]);
  }
  const categoriesWithHindi = await Category.collection.countDocuments({ nameHi: { $exists: true } });
  if (categoriesWithHindi) {
    plan.push([`remove Hindi names from ${categoriesWithHindi} categories`, () =>
      Category.collection.updateMany({}, { $unset: { nameHi: '' } })]);
  }

  if (!plan.length) console.log('[catalog] already up to date');
  for (const [what, act] of plan) {
    console.log(`[catalog] ${APPLY ? '' : '(dry run) '}${what}`);
    if (APPLY) await act();
  }
  if (!APPLY && plan.length) console.log('[catalog] run again with --apply to make these changes');
  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error('[catalog] failed:', err);
  await mongoose.disconnect();
  process.exit(1);
});
