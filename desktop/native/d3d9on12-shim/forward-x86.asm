.686p
.xmm
.model flat
EXTERN _ResolveD3D9Export@4:PROC
EXTERN _g_system_exports:DWORD
.code
SYSTEM_STUB MACRO number
PUBLIC _ShimSystem&number
_ShimSystem&number PROC
    pushfd
    pushad
    mov eax, esp
    and esp, -16
    sub esp, 528
    mov [esp+512], eax
    fxsave [esp]
    push number
    call _ResolveD3D9Export@4
    fxrstor [esp]
    mov esp, [esp+512]
    popad
    popfd
    jmp DWORD PTR [_g_system_exports + number * 4]
_ShimSystem&number ENDP
ENDM
SYSTEM_STUB 0
SYSTEM_STUB 1
SYSTEM_STUB 2
SYSTEM_STUB 3
SYSTEM_STUB 4
SYSTEM_STUB 5
SYSTEM_STUB 6
SYSTEM_STUB 7
SYSTEM_STUB 8
SYSTEM_STUB 9
SYSTEM_STUB 10
SYSTEM_STUB 11
SYSTEM_STUB 12
SYSTEM_STUB 13
SYSTEM_STUB 14
SYSTEM_STUB 15
SYSTEM_STUB 16
SYSTEM_STUB 17
SYSTEM_STUB 18
END
