'use strict';
/**
 * 歌曲能量分析结果缓存
 *
 * 落盘位置：data/cache/analysis/{trackId}.json
 * trackId 由前端用「音源 + 音源内歌曲 ID」生成，稳定不变；
 * 这里只做文件名安全化和读写，不参与 ID 生成。
 */

const fs = require('fs');
const path = require('path');

const { fileInData } = require('./paths');
const CACHE_DIR = fileInData('cache', 'analysis');

/** 去掉文件名非法字符 */
function safeName(trackId) {
  return String(trackId).replace(/[\\/:*?"<>|]/g, '_');
}

function fileFor(trackId) {
  return path.join(CACHE_DIR, safeName(trackId) + '.json');
}

function read(trackId) {
  try {
    const f = fileFor(trackId);
    if (fs.existsSync(f)) {
      const raw = fs.readFileSync(f, 'utf8');
      const data = JSON.parse(raw);
      return data;
    }
  } catch (err) {
    console.warn('[analysis] 读取缓存失败:', err.message);
  }
  return null;
}

function write(trackId, data) {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(fileFor(trackId), JSON.stringify(data), 'utf8');
    return true;
  } catch (err) {
    console.warn('[analysis] 写入缓存失败:', err.message);
    return false;
  }
}

module.exports = { read, write, CACHE_DIR, safeName };
