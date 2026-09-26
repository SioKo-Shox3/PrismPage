// ブラウザ確認用(VITE_MOCK=1)のサンプルの本を `public/mock/` に書き出す。
// ページ画像は図形と文字だけで合成した SVG で、著作物は含まない。出力は決定的(何度実行しても同じ)。
// 使い方: node scripts/generate-mock-assets.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mockDir = path.join(root, 'public', 'mock')

// 決定的な擬似乱数(mulberry32)。
function random(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function svg(width, height, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n${body}\n</svg>\n`
}

function pageLabel(width, height, text, color) {
  return `<text x="${width / 2}" y="${height - 48}" font-family="sans-serif" font-size="28" fill="${color}" text-anchor="middle">${text}</text>`
}

// 漫画風: コマ割りの枠と、斜線・円だけの抽象的な絵。
function mangaPage(index, total) {
  const width = 1200
  const height = 1700
  const rand = random(1000 + index)
  const margin = 80
  const gap = 24
  const rows = 3 + (index % 2)
  const rowHeight = (height - margin * 2 - 80 - gap * (rows - 1)) / rows
  const parts = [`<rect width="${width}" height="${height}" fill="#fbfaf6"/>`]

  for (let row = 0; row < rows; row += 1) {
    const y = margin + row * (rowHeight + gap)
    const split = rand() < 0.6 ? 0.35 + rand() * 0.3 : 1
    const cells = split === 1 ? [[margin, width - margin * 2]] : [
      [margin, (width - margin * 2 - gap) * split],
      [margin + (width - margin * 2 - gap) * split + gap, (width - margin * 2 - gap) * (1 - split)],
    ]
    for (const [x, w] of cells) {
      const shade = 200 + Math.floor(rand() * 40)
      parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${rowHeight}" fill="rgb(${shade},${shade},${shade - 6})" stroke="#1d1b18" stroke-width="6"/>`)
      const cx = x + w * (0.3 + rand() * 0.4)
      const cy = y + rowHeight * (0.3 + rand() * 0.4)
      const r = Math.min(w, rowHeight) * (0.15 + rand() * 0.15)
      parts.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="#fbfaf6" stroke="#1d1b18" stroke-width="4"/>`)
      for (let line = 0; line < 6; line += 1) {
        const lx = x + 12 + line * 18
        parts.push(`<line x1="${lx}" y1="${y + 12}" x2="${lx + 60}" y2="${y + rowHeight - 12}" stroke="#1d1b18" stroke-width="2" opacity="0.35"/>`)
      }
    }
  }

  parts.push(pageLabel(width, height, `試し読み 光の階段 — ${index + 1} / ${total}`, '#1d1b18'))
  return svg(width, height, parts.join('\n'))
}

// 画集風: 色面のグラデーションと円の構成。
function artbookPage(index, total) {
  const width = 1600
  const height = 1200
  const rand = random(2000 + index)
  const hue = (index * 57) % 360
  const parts = [
    `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},55%,78%)"/><stop offset="1" stop-color="hsl(${(hue + 80) % 360},50%,38%)"/></linearGradient></defs>`,
    `<rect width="${width}" height="${height}" fill="url(#bg)"/>`,
  ]
  for (let circle = 0; circle < 7; circle += 1) {
    const cx = rand() * width
    const cy = rand() * height
    const r = 60 + rand() * 260
    const circleHue = (hue + circle * 40) % 360
    parts.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="hsl(${circleHue},65%,60%)" opacity="0.55"/>`)
  }
  parts.push(pageLabel(width, height, `色見本帳 — ${index + 1} / ${total}`, '#ffffff'))
  return svg(width, height, parts.join('\n'))
}

// スキャン風: 黄ばんだ地に、本文の行を模した灰色の帯と紙の汚れ。
function scanPage(index, total) {
  const width = 1240
  const height = 1754
  const rand = random(3000 + index)
  const parts = [`<rect width="${width}" height="${height}" fill="#efe6d2"/>`]
  for (let spot = 0; spot < 30; spot += 1) {
    parts.push(`<circle cx="${(rand() * width).toFixed(1)}" cy="${(rand() * height).toFixed(1)}" r="${(2 + rand() * 6).toFixed(1)}" fill="#b9a988" opacity="0.4"/>`)
  }
  const columns = 18
  for (let column = 0; column < columns; column += 1) {
    const x = width - 140 - column * 56
    const length = 900 + rand() * 500
    parts.push(`<rect x="${x}" y="160" width="22" height="${length.toFixed(1)}" fill="#4a453d" opacity="0.7"/>`)
  }
  parts.push(pageLabel(width, height, `走査の練習帳 — ${index + 1} / ${total}`, '#4a453d'))
  return svg(width, height, parts.join('\n'))
}

const books = [
  { id: 'sample-manga', title: '試し読み 光の階段', kind: 'epub', direction: 'rtl', pageCount: 8, draw: mangaPage },
  { id: 'sample-artbook', title: '色見本帳', kind: 'folder', direction: 'ltr', pageCount: 6, draw: artbookPage },
  { id: 'sample-scan', title: '走査の練習帳', kind: 'archive', direction: 'rtl', pageCount: 4, draw: scanPage },
]

// 書き出し先は public/mock に固定。前回の出力を消してから書き直す。
fs.rmSync(mockDir, { recursive: true, force: true })

const library = { version: 1, books: [] }
for (const book of books) {
  const bookDir = path.join(mockDir, 'books', book.id)
  fs.mkdirSync(bookDir, { recursive: true })
  const pages = []
  for (let index = 0; index < book.pageCount; index += 1) {
    const fileName = `${String(index + 1).padStart(3, '0')}.svg`
    fs.writeFileSync(path.join(bookDir, fileName), book.draw(index, book.pageCount))
    pages.push(`/mock/books/${book.id}/${fileName}`)
  }
  library.books.push({
    id: book.id,
    title: book.title,
    author: 'PrismPage サンプル',
    kind: book.kind,
    direction: book.direction,
    pageCount: book.pageCount,
    cover: pages[0],
    pages,
  })
}

fs.writeFileSync(path.join(mockDir, 'library.json'), `${JSON.stringify(library, null, 2)}\n`)
console.log(`public/mock に ${books.length} 冊のサンプルを書き出しました。`)
