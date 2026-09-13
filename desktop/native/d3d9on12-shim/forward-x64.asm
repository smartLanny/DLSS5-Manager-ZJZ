EXTERN ResolveD3D9Export:PROC
EXTERN g_system_exports:QWORD
.code
SYSTEM_STUB MACRO number
PUBLIC ShimSystem&number
ShimSystem&number PROC FRAME
    sub rsp, 0C8h
    .allocstack 0C8h
    .endprolog
    mov [rsp+20h], rax
    mov [rsp+28h], rcx
    mov [rsp+30h], rdx
    mov [rsp+38h], r8
    mov [rsp+40h], r9
    mov [rsp+48h], r10
    mov [rsp+50h], r11
    movdqu [rsp+60h], xmm0
    movdqu [rsp+70h], xmm1
    movdqu [rsp+80h], xmm2
    movdqu [rsp+90h], xmm3
    movdqu [rsp+0A0h], xmm4
    movdqu [rsp+0B0h], xmm5
    mov ecx, number
    call ResolveD3D9Export
    mov rax, [rsp+20h]
    mov rcx, [rsp+28h]
    mov rdx, [rsp+30h]
    mov r8, [rsp+38h]
    mov r9, [rsp+40h]
    mov r10, [rsp+48h]
    mov r11, [rsp+50h]
    movdqu xmm0, [rsp+60h]
    movdqu xmm1, [rsp+70h]
    movdqu xmm2, [rsp+80h]
    movdqu xmm3, [rsp+90h]
    movdqu xmm4, [rsp+0A0h]
    movdqu xmm5, [rsp+0B0h]
    add rsp, 0C8h
    jmp QWORD PTR [g_system_exports + number * 8]
ShimSystem&number ENDP
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
