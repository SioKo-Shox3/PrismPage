import { closeBooks } from '@/lib/tauri'

// ビューアが開いた本(開いた本と、表紙のために開いた前後の巻)を、どのビューアが持っているかで数える。
// Rust は応答を返す前に本をキャッシュへ置くので、閉じた後に返った応答の本もここで手放す。
// 手放すのは誰も持っていない本だけで、閉じた直後に同じ本を開き直したビューアの本は消さない。

// 本 ID ごとの持ち主の数。
const holders = new Map<string, number>()
// 応答を待っている要求の数。
let pending = 0
// 持ち主がいなくなり、手放すのを待っている本。
const orphans = new Set<string>()

// 本を開く要求を 1 件始める。返した関数に、応答で得た本 ID と、その本を持つか(要求したビューアが
// まだ開いているか)を渡す。失敗したときは空の ID で呼ぶ。2 回目以降の呼び出しは無視する。
export function startBookRequest(): (bookIds: readonly string[], keep: boolean) => void {
  pending += 1
  let settled = false
  return (bookIds, keep) => {
    if (settled) return
    settled = true
    pending -= 1
    for (const id of bookIds) {
      if (keep) holders.set(id, (holders.get(id) ?? 0) + 1)
      else orphans.add(id)
    }
    flush()
  }
}

// ビューアが持っていた本を手放す。持ち主がいなくなった本は Rust のキャッシュから外す。
export function releaseBooks(bookIds: readonly string[]) {
  for (const id of bookIds) {
    const count = holders.get(id) ?? 0
    if (count > 1) {
      holders.set(id, count - 1)
    } else {
      holders.delete(id)
      orphans.add(id)
    }
  }
  flush()
}

// 持ち主のいない本を閉じる。応答待ちの要求があるうちは、その結果が同じ本を持つかもしれないので待つ。
// 待っている要求が無いときに送るので、閉じる要求は後から送られる開く要求より先に Rust へ届く。
function flush() {
  if (pending > 0 || orphans.size === 0) return
  const ids = [...orphans].filter((id) => !holders.has(id))
  orphans.clear()
  if (ids.length > 0) void closeBooks(ids).catch(() => {})
}
