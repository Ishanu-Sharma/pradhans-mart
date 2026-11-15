import { launchProblems } from './launch-lib.js';

const problems = launchProblems();
if (problems.length) {
  console.log(`Not ready to launch. ${problems.length} item(s) to fix:\n`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log('Ready to launch: every launch check passes.');
