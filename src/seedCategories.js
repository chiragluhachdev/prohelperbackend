import mongoose from 'mongoose';
import { Category } from './models/index.js';
import { MONGO_URI } from './config.js';

const CATEGORIES = [
  { name: 'Maid Service', icon: 'home', color: 'forest700', active: true, sortOrder: 1, comingSoon: false },
  { name: 'Plumber', icon: 'build', color: 'forest700', active: true, sortOrder: 2, comingSoon: true },
  { name: 'Electrician', icon: 'bulb', color: 'ember', active: true, sortOrder: 3, comingSoon: true },
];

async function seedCategories() {
  await mongoose.connect(MONGO_URI);
  console.log('[seed] Connected to DB');

  for (const cat of CATEGORIES) {
    await Category.updateOne(
      { name: cat.name },
      { $set: cat },
      { upsert: true }
    );
  }

  console.log('[seed] Categories seeded successfully.');
  process.exit(0);
}

seedCategories().catch((e) => {
  console.error(e);
  process.exit(1);
});
