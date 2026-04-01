#!/usr/bin/env node
/**
 * Build script: generates a filtered JSON index of ScanCode Toolkit license rules.
 *
 * Rules are text variants of licenses observed in the wild. The canonical license
 * text (from LicenseDB) may differ from what projects actually use in their LICENSE
 * files — rules capture those real-world variants.
 *
 * Usage:
 *   npm install
 *   npm run build-rules
 *
 * Output: rules-index.json in the repo root.
 *
 * This is also run automatically by the GitHub Actions workflow on a weekly
 * schedule, with the result deployed to GitHub Pages.
 */

import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import yaml from 'js-yaml';

const REPO_URL = 'https://github.com/aboutcode-org/scancode-toolkit.git';
const BRANCH = 'develop';
const RULES_PATH = 'src/licensedcode/data/rules';
const LICENSES_PATH = 'src/licensedcode/data/licenses';

// Only include rules whose body is at least this many characters.
// Filters out stubs that technically have is_license_text but are too short
// to be meaningful for full-text comparison.
const MIN_TEXT_LENGTH = 150;

// Frontmatter regex: matches --- on its own line, YAML content, --- on its own line.
// Everything after the closing --- is the rule text body.
const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?\r?\n)---[ \t]*\r?\n?([\s\S]*)$/;

function parseFrontmatter(content) {
  const m = content.match(FRONTMATTER_RE);
  if (!m) return null;
  try {
    const meta = yaml.load(m[1]);
    const text = (m[2] || '').trim();
    return { meta, text };
  } catch {
    return null;
  }
}

function buildLicenseMetadataMap(licensesDir) {
  const map = new Map(); // license_key -> { name, spdx_license_key, category }
  let parsed = 0;
  let errors = 0;

  const files = readdirSync(licensesDir).filter(f => f.endsWith('.LICENSE'));
  for (const file of files) {
    const content = readFileSync(join(licensesDir, file), 'utf-8');
    const result = parseFrontmatter(content);
    if (!result?.meta?.key) {
      errors++;
      continue;
    }
    const m = result.meta;
    map.set(m.key, {
      name: m.name || m.short_name || m.key,
      spdx_license_key: m.spdx_license_key || null,
      category: m.category || null,
      is_deprecated: m.is_deprecated === true || String(m.is_deprecated).toLowerCase() === 'yes',
    });
    parsed++;
  }

  console.log(`Parsed ${parsed} license metadata entries (${errors} errors).`);
  return map;
}

function main() {
  const tempDir = join(process.cwd(), '.tmp-scancode');

  try {
    // 1. Sparse-checkout the repo (rules + licenses directories only)
    console.log('Cloning ScanCode Toolkit (sparse checkout)...');
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
    execSync(
      `git clone --depth 1 --filter=blob:none --sparse --branch ${BRANCH} "${REPO_URL}" "${tempDir}"`,
      { stdio: 'inherit' }
    );
    execSync(
      `git -C "${tempDir}" sparse-checkout set ${RULES_PATH} ${LICENSES_PATH}`,
      { stdio: 'inherit' }
    );

    // 2. Build license metadata map (to resolve license_expression → name/SPDX key)
    console.log('\nBuilding license metadata map...');
    const licensesDir = join(tempDir, LICENSES_PATH);
    const licenseMetadata = buildLicenseMetadataMap(licensesDir);

    // 3. Read and parse rules
    console.log('\nProcessing rules...');
    const rulesDir = join(tempDir, RULES_PATH);
    const files = readdirSync(rulesDir).filter(f => f.endsWith('.RULE'));
    console.log(`Found ${files.length} rule files.`);

    const rules = [];
    const stats = {
      total: files.length,
      skippedNoFrontmatter: 0,
      skippedNotLicenseText: 0,
      skippedTooShort: 0,
      parseErrors: 0,
      unmappedExpressions: new Set(),
    };

    for (const file of files) {
      const content = readFileSync(join(rulesDir, file), 'utf-8');
      const result = parseFrontmatter(content);

      if (!result) {
        stats.skippedNoFrontmatter++;
        continue;
      }

      // js-yaml 4.x (YAML 1.2 core schema) parses `yes` as string "yes",
      // not boolean true. Accept both forms.
      const isText = result.meta?.is_license_text;
      if (isText !== true && String(isText).toLowerCase() !== 'yes') {
        stats.skippedNotLicenseText++;
        continue;
      }

      if (result.text.length < MIN_TEXT_LENGTH) {
        stats.skippedTooShort++;
        continue;
      }

      const ruleId = basename(file, '.RULE');
      const licenseExpression = result.meta.license_expression || '';
      const relevance = result.meta.relevance ?? 100;

      // Resolve the primary license key from the expression.
      // Most is_license_text rules have a simple single-key expression.
      // For compound expressions (e.g. "mit AND apache-2.0"), extract the first key.
      const primaryKey = licenseExpression
        .split(/\s+(?:AND|OR|WITH)\s+/i)[0]
        ?.trim() || licenseExpression;

      const licenseMeta = licenseMetadata.get(primaryKey);
      if (!licenseMeta) {
        stats.unmappedExpressions.add(primaryKey);
      }

      rules.push({
        id: ruleId,
        license_key: primaryKey,
        license_expression: licenseExpression !== primaryKey ? licenseExpression : undefined,
        name: licenseMeta?.name || primaryKey,
        spdx_license_key: licenseMeta?.spdx_license_key || null,
        category: licenseMeta?.category || null,
        is_deprecated: licenseMeta?.is_deprecated || false,
        relevance,
        text: result.text,
      });
    }

    // 4. Get source commit hash for versioning
    const commitHash = execSync(`git -C "${tempDir}" rev-parse HEAD`, { encoding: 'utf-8' }).trim();

    // 5. Sort rules by license_key then by id for consistency
    rules.sort((a, b) => a.license_key.localeCompare(b.license_key) || a.id.localeCompare(b.id));

    // 6. Write output
    const output = {
      version: new Date().toISOString().slice(0, 10),
      sourceCommit: commitHash,
      sourceBranch: BRANCH,
      generatedAt: new Date().toISOString(),
      totalRulesInRepo: files.length,
      includedRules: rules.length,
      rules,
    };

    const jsonStr = JSON.stringify(output);
    const outputPath = join(process.cwd(), 'rules-index.json');
    writeFileSync(outputPath, jsonStr);

    // 7. Stats
    const textLengths = rules.map(r => r.text.length);
    const totalChars = textLengths.reduce((a, b) => a + b, 0);
    const uniqueLicenseKeys = new Set(rules.map(r => r.license_key));

    console.log('\n--- Build Stats ---');
    console.log(`Total .RULE files:            ${stats.total}`);
    console.log(`Skipped (no frontmatter):     ${stats.skippedNoFrontmatter}`);
    console.log(`Skipped (not license text):   ${stats.skippedNotLicenseText}`);
    console.log(`Skipped (too short <${MIN_TEXT_LENGTH}):   ${stats.skippedTooShort}`);
    console.log(`Parse errors:                 ${stats.parseErrors}`);
    console.log(`Included rules:               ${rules.length}`);
    console.log(`Unique license keys:          ${uniqueLicenseKeys.size}`);
    console.log(`Unmapped expressions:         ${stats.unmappedExpressions.size}`);
    if (stats.unmappedExpressions.size) {
      console.log(`  Keys: ${[...stats.unmappedExpressions].slice(0, 20).join(', ')}${stats.unmappedExpressions.size > 20 ? '...' : ''}`);
    }
    console.log(`Output size (uncompressed):   ${(jsonStr.length / 1024 / 1024).toFixed(2)} MB`);
    console.log(`Avg text length:              ${Math.round(totalChars / (rules.length || 1))} chars`);
    console.log(`Min text length:              ${Math.min(...textLengths)} chars`);
    console.log(`Max text length:              ${Math.max(...textLengths)} chars`);
    console.log(`Written to: ${outputPath}`);

  } finally {
    // Cleanup
    if (existsSync(tempDir)) {
      console.log('\nCleaning up temp directory...');
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

main();
