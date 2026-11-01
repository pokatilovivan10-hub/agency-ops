import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanProjectName, extractProjectName, normalizeProjectName } from '../lib/call-intake.mjs';

test('extracts the project from the final trigger phrase', () => {
  assert.equal(extractProjectName({ transcript: 'Обсудили запуск.\nПроект Мария' }), 'Мария');
  assert.equal(extractProjectName({ transcript: 'Итог встречи. Проект: Северный дом.' }), 'Северный дом');
});

test('does not create a project without the explicit trigger phrase', () => {
  assert.equal(extractProjectName({ transcript: 'Мы обсуждали проект Мария и сроки запуска.' }), '');
});

test('explicit project name has priority over transcript', () => {
  assert.equal(extractProjectName({ project_name: 'Альфа', transcript: 'Проект Бета' }), 'Альфа');
});

test('normalization supports case, punctuation and Russian yo', () => {
  assert.equal(normalizeProjectName('  «Ёлка  Дом» '), normalizeProjectName('елка-дом'));
  assert.equal(cleanProjectName('«Мария». '), 'Мария');
});
