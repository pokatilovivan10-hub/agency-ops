import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8');

test('theme toggle persists and is available in the CRM shell', () => {
  assert.match(app, /THEME_KEY='crmTheme'/);
  assert.match(app, /data-theme-toggle/);
  assert.match(app, /localStorage\.setItem\(THEME_KEY,next\)/);
  assert.match(css, /html\[data-theme=dark\]/);
});

test('mobile sales keeps navigation and touch targets usable', () => {
  assert.match(css, /\.shell:has\(\.sales-board\) \.topbar\{display:flex\}/);
  assert.match(css, /\.mobile-menu\{[^}]*min-width:44px;min-height:44px/);
  assert.match(css, /\.lead-advance\{width:44px;height:44px/);
  assert.match(css, /\.field input,\.field select,\.field textarea\{font-size:16px/);
});

test('profile opens from the account block instead of a duplicate nav item', () => {
  assert.doesNotMatch(app, /<button data-view="account"/);
  assert.match(app, /id="userProfile" title="Открыть профиль"/);
  assert.match(app, /\$\('#userProfile'\)\.onclick=\(\)=>navigate\('account'\)/);
  assert.match(css, /\.user-profile\{[^}]*min-height:52px/);
});

test('project result workspace exposes KPI passport, daily audits and action log', () => {
  assert.match(app, /\['success','Результат'\]/);
  assert.match(app, /function successView\(/);
  assert.match(app, /function successProfileModal\(/);
  assert.match(app, /function dailyAuditModal\(/);
  assert.match(app, /function optimizationModal\(/);
  assert.match(app, /Паспорт результата/);
  assert.match(app, /Журнал корректировок/);
  assert.match(css, /\.action-log\{/);
});
