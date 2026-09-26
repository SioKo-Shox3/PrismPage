; PrismPage を対応する拡張子の「プログラムから開く」にだけ登録するインストーラーのフック。
; 各拡張子の既定のアプリ(Software\Classes\.<ext> の (既定) の値)には一切触れない。
; 書き込み先は SHCTX で、インストーラーが installMode に合わせて切り替える
; (currentUser なら HKCU、perMachine なら HKLM)。アンインストール時はここで書いた値だけを消す。

; PrismPage が「プログラムから開く」の候補として名乗るクラス(ProgID)。
!define PRISMPAGE_PROGID "PrismPage.Book"
; Software\Classes\Applications の下に置く実行ファイル名のキー。
!define PRISMPAGE_APP_KEY "Software\Classes\Applications\${MAINBINARYNAME}.exe"

; 拡張子 1 つを「プログラムから開く」に載せる。
!macro PRISMPAGE_ADD_OPEN_WITH EXT
  ; .<ext>\OpenWithProgids に PrismPage のクラス名を値の名前として足す(値の中身は空)。
  ; 同じキーにある他のアプリの値と (既定) の値は変えない。
  WriteRegStr SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${PRISMPAGE_PROGID}" ""
  ; Applications\<exe 名>\SupportedTypes に拡張子を値の名前として足す(値の中身は空)。
  WriteRegStr SHCTX "${PRISMPAGE_APP_KEY}\SupportedTypes" ".${EXT}" ""
!macroend

; 拡張子 1 つから PrismPage の登録を外す。
!macro PRISMPAGE_REMOVE_OPEN_WITH EXT
  ; インストール時に足した値だけを消し、OpenWithProgids のキー自体と他のアプリの値は残す。
  DeleteRegValue SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${PRISMPAGE_PROGID}"
  ; SupportedTypes からも足した拡張子の値だけを消す。
  DeleteRegValue SHCTX "${PRISMPAGE_APP_KEY}\SupportedTypes" ".${EXT}"
!macroend

; (既定) の値を消し、そのキーに値も子キーも残っていなければキーも消す。
; /ifempty は値か子キーが 1 つでもあればキーを残す(他のアプリやユーザーが足したものを消さない)。
!macro PRISMPAGE_REMOVE_DEFAULT_VALUE KEY
  DeleteRegValue SHCTX "${KEY}" ""
  DeleteRegKey /ifempty SHCTX "${KEY}"
!macroend

; 対応する拡張子の一覧(起動引数で受け付ける画像・アーカイブ・EPUB・PDF と同じ)。
!macro PRISMPAGE_FOR_EACH_EXT MACRO
  !insertmacro ${MACRO} "jpg"
  !insertmacro ${MACRO} "jpeg"
  !insertmacro ${MACRO} "png"
  !insertmacro ${MACRO} "webp"
  !insertmacro ${MACRO} "avif"
  !insertmacro ${MACRO} "gif"
  !insertmacro ${MACRO} "bmp"
  !insertmacro ${MACRO} "zip"
  !insertmacro ${MACRO} "cbz"
  !insertmacro ${MACRO} "rar"
  !insertmacro ${MACRO} "cbr"
  !insertmacro ${MACRO} "epub"
  !insertmacro ${MACRO} "pdf"
!macroend

; エクスプローラーに関連付けの変更を知らせる(SHCNE_ASSOCCHANGED・SHCNF_IDLIST)。
!macro PRISMPAGE_NOTIFY_ASSOC_CHANGED
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; ファイルを置く前にすることは無い。
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; PrismPage のクラスを作る。(既定) は種類の表示名。
  WriteRegStr SHCTX "Software\Classes\${PRISMPAGE_PROGID}" "" "PrismPage で開く本・画像"
  ; クラスのアイコンは実行ファイルの先頭のアイコン。
  WriteRegStr SHCTX "Software\Classes\${PRISMPAGE_PROGID}\DefaultIcon" "" '"$INSTDIR\${MAINBINARYNAME}.exe",0'
  ; クラスで開くときのコマンド: "<exe>" "%1"。
  WriteRegStr SHCTX "Software\Classes\${PRISMPAGE_PROGID}\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'

  ; 「プログラムから開く」の一覧に出す名前と、そこから開くときのコマンド: "<exe>" "%1"。
  WriteRegStr SHCTX "${PRISMPAGE_APP_KEY}" "FriendlyAppName" "PrismPage"
  WriteRegStr SHCTX "${PRISMPAGE_APP_KEY}\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'

  ; 各拡張子の OpenWithProgids と SupportedTypes に足す。
  !insertmacro PRISMPAGE_FOR_EACH_EXT PRISMPAGE_ADD_OPEN_WITH

  !insertmacro PRISMPAGE_NOTIFY_ASSOC_CHANGED
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; インストール時に書いた値だけを消し、空になったキーだけを末端から片付ける。
  ; キーを配下ごと消すことはしない(ユーザーが「プログラムから開く → 参照」で exe を選ぶと
  ; Windows も Applications\<exe 名> に書くことがあり、他のアプリやユーザーの値を巻き込むため)。

  ; 各拡張子の OpenWithProgids のクラス名と、SupportedTypes の拡張子の値を消す。
  !insertmacro PRISMPAGE_FOR_EACH_EXT PRISMPAGE_REMOVE_OPEN_WITH

  ; Applications\<exe 名>: SupportedTypes → shell\open\command → shell\open → shell → 本体の順に片付ける。
  DeleteRegKey /ifempty SHCTX "${PRISMPAGE_APP_KEY}\SupportedTypes"
  !insertmacro PRISMPAGE_REMOVE_DEFAULT_VALUE "${PRISMPAGE_APP_KEY}\shell\open\command"
  DeleteRegKey /ifempty SHCTX "${PRISMPAGE_APP_KEY}\shell\open"
  DeleteRegKey /ifempty SHCTX "${PRISMPAGE_APP_KEY}\shell"
  DeleteRegValue SHCTX "${PRISMPAGE_APP_KEY}" "FriendlyAppName"
  DeleteRegKey /ifempty SHCTX "${PRISMPAGE_APP_KEY}"

  ; PrismPage のクラス: shell\open\command → shell\open → shell → DefaultIcon → 本体の順に片付ける。
  !insertmacro PRISMPAGE_REMOVE_DEFAULT_VALUE "Software\Classes\${PRISMPAGE_PROGID}\shell\open\command"
  DeleteRegKey /ifempty SHCTX "Software\Classes\${PRISMPAGE_PROGID}\shell\open"
  DeleteRegKey /ifempty SHCTX "Software\Classes\${PRISMPAGE_PROGID}\shell"
  !insertmacro PRISMPAGE_REMOVE_DEFAULT_VALUE "Software\Classes\${PRISMPAGE_PROGID}\DefaultIcon"
  !insertmacro PRISMPAGE_REMOVE_DEFAULT_VALUE "Software\Classes\${PRISMPAGE_PROGID}"

  !insertmacro PRISMPAGE_NOTIFY_ASSOC_CHANGED
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; ファイルを消した後にすることは無い。
!macroend
