; 文件关联：双击书 → 用岑序打开。
;
; 装法是 per-user（installMode: currentUser），所以写 HKCU，不需要管理员权限。
;
; 策略：
; 1. 所有支持的扩展名都写进 OpenWithProgids —— 只是让岑序出现在右键「打开方式」里，
;    不抢别人已有的默认程序。用户的 .txt 默认是记事本、.pdf 默认是浏览器，这些不该被动。
; 2. 只对「本来就没有默认程序」的冷门格式（cbz/cbr/cbt/cb7/ofd）直接把默认值指过来，
;    这些格式用户双击时本来就是「选择打开方式」，指过来是纯收益。
;
; 卸载时逐个清理，并且只在默认值确实是自己时才删，避免把用户后来改的设置一起抹掉。

!macro CENRO_REGISTER_OPENWITH EXT
  WriteRegStr HKCU "Software\Classes\${EXT}\OpenWithProgids" "Cenro.Book" ""
!macroend

!macro CENRO_SET_DEFAULT EXT
  WriteRegStr HKCU "Software\Classes\${EXT}" "" "Cenro.Book"
!macroend

!macro CENRO_UNREGISTER EXT
  DeleteRegValue HKCU "Software\Classes\${EXT}\OpenWithProgids" "Cenro.Book"
  ; 只有默认值还指向自己时才清空，用户改过的话保持原样
  ReadRegStr $0 HKCU "Software\Classes\${EXT}" ""
  StrCmp $0 "Cenro.Book" 0 +2
    DeleteRegValue HKCU "Software\Classes\${EXT}" ""
!macroend

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Classes\Cenro.Book" "" "岑序电子书"
  WriteRegStr HKCU "Software\Classes\Cenro.Book\DefaultIcon" "" "$INSTDIR\cenro.exe,0"
  WriteRegStr HKCU "Software\Classes\Cenro.Book\shell\open\command" "" '"$INSTDIR\cenro.exe" "%1"'

  !insertmacro CENRO_REGISTER_OPENWITH ".epub"
  !insertmacro CENRO_REGISTER_OPENWITH ".mobi"
  !insertmacro CENRO_REGISTER_OPENWITH ".azw3"
  !insertmacro CENRO_REGISTER_OPENWITH ".fb2"
  !insertmacro CENRO_REGISTER_OPENWITH ".txt"
  !insertmacro CENRO_REGISTER_OPENWITH ".md"
  !insertmacro CENRO_REGISTER_OPENWITH ".html"
  !insertmacro CENRO_REGISTER_OPENWITH ".docx"
  !insertmacro CENRO_REGISTER_OPENWITH ".rtf"
  !insertmacro CENRO_REGISTER_OPENWITH ".xlsx"
  !insertmacro CENRO_REGISTER_OPENWITH ".pdf"
  !insertmacro CENRO_REGISTER_OPENWITH ".cbz"
  !insertmacro CENRO_REGISTER_OPENWITH ".cbr"
  !insertmacro CENRO_REGISTER_OPENWITH ".cbt"
  !insertmacro CENRO_REGISTER_OPENWITH ".cb7"
  !insertmacro CENRO_REGISTER_OPENWITH ".ofd"

  ; 冷门格式直接接管默认
  !insertmacro CENRO_SET_DEFAULT ".cbz"
  !insertmacro CENRO_SET_DEFAULT ".cbr"
  !insertmacro CENRO_SET_DEFAULT ".cbt"
  !insertmacro CENRO_SET_DEFAULT ".cb7"
  !insertmacro CENRO_SET_DEFAULT ".ofd"

  ; 通知外壳「关联变了」，否则资源管理器要重启才认
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegKey HKCU "Software\Classes\Cenro.Book"

  !insertmacro CENRO_UNREGISTER ".epub"
  !insertmacro CENRO_UNREGISTER ".mobi"
  !insertmacro CENRO_UNREGISTER ".azw3"
  !insertmacro CENRO_UNREGISTER ".fb2"
  !insertmacro CENRO_UNREGISTER ".txt"
  !insertmacro CENRO_UNREGISTER ".md"
  !insertmacro CENRO_UNREGISTER ".html"
  !insertmacro CENRO_UNREGISTER ".docx"
  !insertmacro CENRO_UNREGISTER ".rtf"
  !insertmacro CENRO_UNREGISTER ".xlsx"
  !insertmacro CENRO_UNREGISTER ".pdf"
  !insertmacro CENRO_UNREGISTER ".cbz"
  !insertmacro CENRO_UNREGISTER ".cbr"
  !insertmacro CENRO_UNREGISTER ".cbt"
  !insertmacro CENRO_UNREGISTER ".cb7"
  !insertmacro CENRO_UNREGISTER ".ofd"

  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
