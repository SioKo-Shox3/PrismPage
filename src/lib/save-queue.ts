// 読書位置・表示設定の保存の列。保存は 1 本の列で要求した順に 1 件ずつ行う。
// 並べて送ると後の保存が先に終わり、古い値で上書きされうる。
// 列は画面の外(モジュール)に置くので、ビューアを閉じた後の書き出しも順に行われる。
// 読書状態を返す command は `tauri.ts` のラッパーが `whenSavesSettled` を待ってから呼ぶ。
const saveQueue: Array<() => Promise<void>> = []
let draining: Promise<void> | null = null

// 保存を列の最後に足す。列が空いていれば、最初の保存はこの呼び出しの中で送る。
export function enqueueSave(save: () => Promise<void>) {
  saveQueue.push(save)
  draining ??= drainSaveQueue()
}

async function drainSaveQueue() {
  for (let save = saveQueue.shift(); save; save = saveQueue.shift()) {
    // 保存に失敗しても読書は続けられるので、画面には出さない(次の操作でまた保存する)。
    await save().catch(() => {})
  }
  draining = null
}

// 待っている保存がすべて終わるまで待つ。閉じた直後に本や一覧を読み直しても保存済みの値を読む。
export function whenSavesSettled(): Promise<void> {
  return draining ?? Promise.resolve()
}
