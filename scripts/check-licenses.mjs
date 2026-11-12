import { execSync } from 'node:child_process';

const packages = JSON.parse(execSync('pnpm licenses list --prod --recursive --json', { encoding: 'utf8' }));
const allowed = new Set(['MIT', 'MIT-0', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'ISC']);
const rejected = [];

for (const [expression, dependencies] of Object.entries(packages)) {
  // type-fest offers a choice: this application selects its MIT licence.
  const selected = expression === '(MIT OR CC0-1.0)' ? 'MIT' : expression;
  const ids = selected.match(/\b(?:MIT-0|MIT|Apache-2\.0|BSD-2-Clause|BSD-3-Clause|0BSD|ISC)\b/g) ?? [];
  const remainder = selected
    .replace(/\b(?:MIT-0|MIT|Apache-2\.0|BSD-2-Clause|BSD-3-Clause|0BSD|ISC)\b/g, '')
    .replace(/\b(?:AND|OR|WITH)\b/g, '')
    .replace(/[()]/g, '')
    .trim();

  if (!ids.length || remainder || ids.some(id => !allowed.has(id)) || !Array.isArray(dependencies)) {
    const names = Array.isArray(dependencies)
      ? dependencies.map(pkg => `${pkg.name}@${pkg.version ?? pkg.versions?.join(',') ?? 'unknown version'}`).join(', ')
      : 'invalid package list';
    rejected.push(`${expression}: ${names}`);
  }
}

if (rejected.length) {
  console.error('Disallowed, unknown, or unrecognised production dependency licences:');
  console.error(rejected.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Production dependency licences are allowlisted (${Object.values(packages).flat().length} packages).`);
}
