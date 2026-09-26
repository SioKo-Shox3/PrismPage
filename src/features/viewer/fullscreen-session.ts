import { isWindowFullscreen, setWindowFullscreen } from '@/lib/window-fullscreen'

// ビューアの全画面。ビューアを開いている間を 1 つの区切りとし、開いたときにウィンドウを全画面にして、
// 閉じるときはビューアが全画面にしたときだけ元のウィンドウに戻す。
// - 開く前から全画面なら何もせず、閉じても戻さない。
// - 設定で全画面で開かないときは、開いてもウィンドウのまま(F / F11 で全画面にしたら閉じるときに戻す)。
// - F / F11 の切り替えは、全画面にしたらビューアが全画面にしたものとし、ウィンドウに戻したら閉じても何もしない。
// - 次の巻・前の巻へ移っても区切りは続く(ビューアの画面は残り、中の本だけが入れ替わる)。
// ウィンドウの操作は非同期なので、順番どおりに 1 つずつ実行する。

// ビューアを開いている数(開発時の StrictMode では開く・閉じる・開くが続けて走る)。
let holders = 0
// 区切りの途中か(開いてから、閉じた後の戻しを積むまで)。
let active = false
// 今の全画面をビューアが作ったか。閉じるときに戻すかどうかを決める。
let owned = false
let queue: Promise<void> = Promise.resolve()

function enqueue(task: () => Promise<void>) {
  // 失敗(DOM の全画面が断られた等)は無視して次の操作へ進む。
  queue = queue.then(task).catch(() => {})
}

// ビューアを開いたことを知らせ、`enter` なら全画面にする。返した関数でビューアを閉じたことを知らせる。
// 閉じた後の戻しは同じ処理の中で開き直されなかったときだけ行う(StrictMode の開き直しで点滅させない)。
export function holdViewerFullscreen(enter = true): () => void {
  holders += 1
  if (!active) {
    active = true
    enqueue(async () => {
      if (!enter || (await isWindowFullscreen())) {
        owned = false
        return
      }
      await setWindowFullscreen(true)
      owned = true
    })
  }
  let released = false
  return () => {
    if (released) return
    released = true
    holders -= 1
    void Promise.resolve().then(() => {
      if (holders > 0 || !active) return
      active = false
      enqueue(async () => {
        if (!owned) return
        owned = false
        await setWindowFullscreen(false)
      })
    })
  }
}

// F / F11: 全画面とウィンドウを切り替える。
export function toggleViewerFullscreen() {
  enqueue(async () => {
    const fullscreen = await isWindowFullscreen()
    await setWindowFullscreen(!fullscreen)
    owned = !fullscreen
  })
}
