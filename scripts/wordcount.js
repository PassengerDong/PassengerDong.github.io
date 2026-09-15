'use strict';

function normalizeContent(content) {
  return String(content || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-zA-Z#0-9]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function countWords(content) {
  const text = normalizeContent(content);
  if (!text) return 0;

  const cjk = text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || [];
  const latinWords = text
    .replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g, ' ')
    .match(/[A-Za-z0-9]+(?:[-_./][A-Za-z0-9]+)*/g) || [];

  return cjk.length + latinWords.length;
}

hexo.extend.helper.register('wordcount', function wordcount(content) {
  return countWords(content);
});

hexo.extend.helper.register('min2read', function min2read(content) {
  return Math.max(1, Math.ceil(countWords(content) / 300));
});
