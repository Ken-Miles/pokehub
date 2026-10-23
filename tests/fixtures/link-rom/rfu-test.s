@ Homebrew GBA test program for the emulated Wireless Adapter
@ (tests/emulator-core.test.ts). Our own code, no game data. It talks to the
@ adapter the way librfu does (pokeemerald src/librfu_*.c): the Sio32ID
@ login, commands word by word with the SI/SO ready handshake after each,
@ and the clock handed to the adapter after a "change" command.
@ Holding A at power-on makes it the client; otherwise it hosts.
@   host:   open a room, wait for a child, close it, wait 60 frames, then
@           send 0x1000+k (send-and-wait) with a new k every frame, as
@           the games do (k = 0..63, then 63 again), recording each new
@           answer, until it has 64; then disconnect the child
@   client: search, connect to the host, then wait; on data, record the
@           host's word if new and answer 0x2000 | its low 12 bits
@ Holding B instead makes it a scanner: 16 search polls, marking word (ID & 31) from
@ 0x02000100 for every host a poll reports, then done.
@ Results at 0x02000000: [0] side (0 host, 1 client, 2 scanner), [1] login ID (after a stop and a reset),
@ [2] stage (1 logged in, 2 linked, 3 done), [3] words recorded,
@ [4] host: child (id | slot << 16), client: own (id | slot << 16),
@ [5] client: 1 if the host disconnected it, [6] client: wait timeouts,
@ [7] the first request word the adapter answered with anything but 0x80000000 (librfu then times out),
@ then from 0x02000100 the recorded words.
@ Build: tests/fixtures/link-rom/build.sh

	.arm
	.text
	.global _start

@ No linker resolves `bl`, so calls are spelled out (the PC reads two instructions ahead).
	.macro	call target
	mov	lr, pc
	b	\target
	.endm

_start:
	b	main			@ 0x00: jump over the cartridge header
	.fill	0x9c, 1, 0		@ 0x04: logo (not checked without a BIOS)
	.ascii	"HUBRFUTEST\0\0"	@ 0xa0: title
	.ascii	"ZHRE"			@ 0xac: game code (not a real game's)
	.ascii	"00"			@ 0xb0: maker
	.byte	0x96			@ 0xb2: fixed value
	.fill	0x0d, 1, 0		@ 0xb3..0xbf

@ r0 = I/O, r9 = I/O + 0x100 (SIODATA32 +0x20, SIOCNT +0x28, KEYINPUT +0x30, RCNT +0x34),
@ r11 = results; requests' parameters at r11 + 0xA00, replies at r11 + 0x800.
main:
	ldr	sp, =0x03007F00
	ldr	r0, =0x04000000
	ldr	r9, =0x04000100
	ldr	r11, =0x02000000
	mov	r1, #0
	mov	r2, #0
clear:
	str	r1, [r11, r2]
	add	r2, r2, #4
	cmp	r2, #0x200
	blt	clear
	ldrh	r1, [r9, #0x30]		@ KEYINPUT: a bit is 0 while held
	mvn	r1, r1
	and	r10, r1, #3		@ r10 = side: A held = client, B held = scanner
	str	r10, [r11]
	mov	r1, #0
	strh	r1, [r9, #0x34]		@ RCNT = 0: serial port in normal use
	ldr	r1, =0x1003
	strh	r1, [r9, #0x28]		@ SIOCNT: normal 32-bit, internal clock
	call	login
	@ As the games do after "is an adapter connected?": stop it and park the port in
	@ multiplayer mode; later reset it from there (RCNT through GPIO) and log in again.
	mov	r1, #0x3D		@ stop
	mov	r2, #0
	call	cmd
	ldr	r1, =0x2000
	strh	r1, [r9, #0x28]		@ SIOCNT: multiplayer
	ldr	r1, =0x8000
	strh	r1, [r9, #0x34]		@ RCNT: GPIO, the adapter's reset line
	ldr	r1, =0x80A0
	strh	r1, [r9, #0x34]
	ldr	r1, =0x1003
	strh	r1, [r9, #0x28]		@ SIOCNT: 32-bit (still GPIO while RCNT says so)
	mov	r1, #0
	strh	r1, [r9, #0x34]		@ RCNT = 0: normal 32-bit again
	ldr	r1, =0x996600BD		@ librfu's login first clocks out whatever SIODATA32 holds: the stop's reply
	call	xfer
	call	login
	str	r1, [r11, #4]
	mov	r1, #1
	str	r1, [r11, #8]
	mov	r1, #0x10		@ reset
	mov	r2, #0
	call	cmd
	add	r6, r11, #0xA00
	ldr	r1, =0x003C0420		@ system config, as the games set it (32-frame wait timeout)
	str	r1, [r6]
	mov	r1, #0x17
	mov	r2, #1
	call	cmd
	cmp	r10, #2
	beq	scanner
	cmp	r10, #0
	bne	client
	b	host

gameconfig:				@ what the host broadcasts (any 6 words)
	.word	0x48550002, 0x54535542, 0x00000000, 0x2E000000, 0x48554200, 0x00000000

host:
	add	r6, r11, #0xA00		@ game config: 6 words (any)
	adr	r4, gameconfig
	mov	r5, #0
1:	ldr	r1, [r4, r5, lsl #2]
	str	r1, [r6, r5, lsl #2]
	add	r5, r5, #1
	cmp	r5, #6
	blt	1b
	mov	r1, #0x16
	mov	r2, #6
	call	cmd
	mov	r1, #0x19		@ open the room
	mov	r2, #0
	call	cmd
	mov	r4, #0
host_poll:
	call	frame
	mov	r1, #0x1A		@ any children?
	mov	r2, #0
	call	cmd
	cmp	r3, #1
	bge	host_found
	add	r4, r4, #1
	cmp	r4, #600
	blt	host_poll
	b	finish
host_found:
	add	r6, r11, #0x800
	ldr	r1, [r6, #4]
	str	r1, [r11, #16]
	mov	r1, #2
	str	r1, [r11, #8]
	mov	r1, #0x1B		@ close the room
	mov	r2, #0
	call	cmd
	mov	r4, #60			@ quiet for a while: the child's waits time out
1:	call	frame
	subs	r4, r4, #1
	bne	1b
	mov	r4, #0			@ k
	mov	r5, #0			@ rounds
	mov	r7, #0			@ answers recorded
	mov	r8, #0			@ last answer
host_round:
	add	r6, r11, #0xA00
	mov	r1, #4			@ 4 bytes
	str	r1, [r6]
	ldr	r1, =0x1000
	orr	r1, r1, r4
	str	r1, [r6, #4]
	mov	r1, #0x25		@ send, then wait
	mov	r2, #2
	call	cmd
	call	wait_wake
	ldr	r2, =0x99660128		@ a host is woken at once with who received
	cmp	r1, r2
	bne	finish
	mov	r1, #0x26		@ receive
	mov	r2, #0
	call	cmd
	cmp	r3, #2
	blt	host_next
	add	r6, r11, #0x800
	ldr	r1, [r6, #4]		@ byte counts: slot 0 in bits 8..12
	mov	r1, r1, lsr #8
	and	r1, r1, #0x1F
	cmp	r1, #4
	bne	host_next
	ldr	r1, [r6, #8]
	cmp	r1, r8			@ the same answer again
	beq	host_next
	mov	r8, r1
	cmp	r7, #64
	bge	host_next
	add	r2, r11, #0x100
	str	r1, [r2, r7, lsl #2]
	add	r7, r7, #1
	str	r7, [r11, #12]
host_next:
	call	frame
	cmp	r4, #63			@ a new word every frame, as the games send, up to 63
	addlt	r4, r4, #1
	add	r5, r5, #1
	cmp	r5, #2000
	bge	finish
	cmp	r7, #64
	blt	host_round
	add	r6, r11, #0xA00
	mov	r1, #1			@ disconnect slot 0
	str	r1, [r6]
	mov	r1, #0x30
	mov	r2, #1
	call	cmd
	mov	r1, #3
	str	r1, [r11, #8]
	b	finish

client:
	mov	r1, #0x1C		@ search
	mov	r2, #0
	call	cmd
	mov	r4, #0
client_search:
	call	frame
	mov	r1, #0x1D
	mov	r2, #0
	call	cmd
	cmp	r3, #7			@ one host: 7 words
	bge	client_found
	add	r4, r4, #1
	cmp	r4, #600
	blt	client_search
	b	finish
client_found:
	add	r6, r11, #0x800
	ldr	r5, [r6, #4]
	mov	r5, r5, lsl #16
	mov	r5, r5, lsr #16		@ the host's ID
	mov	r1, #0x1E
	mov	r2, #0
	call	cmd
	add	r6, r11, #0xA00
	str	r5, [r6]
	mov	r1, #0x1F		@ connect
	mov	r2, #1
	call	cmd
	mov	r4, #0
client_connect:
	call	frame
	mov	r1, #0x20
	mov	r2, #0
	call	cmd
	add	r6, r11, #0x800
	ldr	r1, [r6, #4]
	movs	r2, r1, lsr #24		@ 0 = connected
	beq	client_connected
	add	r4, r4, #1
	cmp	r4, #600
	blt	client_connect
	b	finish
client_connected:
	str	r1, [r11, #16]
	mov	r7, r1, lsr #16
	and	r7, r7, #3		@ r7 = slot
	mov	r1, #0x21
	mov	r2, #0
	call	cmd
	mov	r1, #2
	str	r1, [r11, #8]
	mov	r4, #0			@ words recorded
	mov	r5, #0			@ last host word
client_wait:
	mov	r1, #0x27		@ wait
	mov	r2, #0
	call	cmd
	call	wait_wake
	ldr	r2, =0x99660027		@ timeout
	cmp	r1, r2
	bne	1f
	ldr	r1, [r11, #24]
	add	r1, r1, #1
	str	r1, [r11, #24]
	b	client_wait
1:	ldr	r2, =0x99660129		@ disconnected
	cmp	r1, r2
	bne	2f
	mov	r1, #1
	str	r1, [r11, #20]
	mov	r1, #3
	str	r1, [r11, #8]
	b	finish
2:	ldr	r2, =0x99660028		@ data
	cmp	r1, r2
	bne	finish
	mov	r1, #0x26
	mov	r2, #0
	call	cmd
	cmp	r3, #2
	blt	client_wait
	add	r6, r11, #0x800
	ldr	r1, [r6, #4]
	and	r1, r1, #0x7F
	cmp	r1, #4
	bne	client_wait
	ldr	r1, [r6, #8]
	cmp	r1, r5
	beq	client_reply
	mov	r5, r1
	cmp	r4, #64
	bge	client_reply
	add	r2, r11, #0x100
	str	r1, [r2, r4, lsl #2]
	add	r4, r4, #1
	str	r4, [r11, #12]
client_reply:
	add	r6, r11, #0xA00
	add	r2, r7, r7, lsl #2
	add	r2, r2, #8		@ a client's byte count sits at bit 8 + 5 * slot
	mov	r1, #4
	mov	r1, r1, lsl r2
	str	r1, [r6]
	mov	r1, r5, lsl #20
	mov	r1, r1, lsr #20
	orr	r1, r1, #0x2000
	str	r1, [r6, #4]
	mov	r1, #0x24		@ send
	mov	r2, #2
	call	cmd
	b	client_wait

scanner:
	mov	r1, #0x1C		@ search
	mov	r2, #0
	call	cmd
	mov	r4, #0
scanner_poll:
	call	frame
	mov	r1, #0x1D
	mov	r2, #0
	call	cmd			@ r3 = reply words, 7 per host, the ID first
	add	r6, r11, #0x800
	add	r6, r6, #4
	add	r8, r11, #0x100
	mov	r7, #1
	mov	r5, #0
1:	cmp	r5, r3
	bge	2f
	ldr	r1, [r6, r5, lsl #2]
	and	r1, r1, #0x1F
	str	r7, [r8, r1, lsl #2]
	add	r5, r5, #7
	b	1b
2:	add	r4, r4, #1
	cmp	r4, #16
	blt	scanner_poll
	mov	r1, #3
	str	r1, [r11, #8]
	b	finish

finish:
	b	finish

@ ---- one 32-bit transfer clocked by the GBA: r1 out, r1 in
xfer:
	str	r1, [r9, #0x20]
	ldr	r2, =0x1083
	strh	r2, [r9, #0x28]
1:	ldrh	r2, [r9, #0x28]
	tst	r2, #0x80
	bne	1b
	ldr	r1, [r9, #0x20]
	bx	lr

@ ---- a transfer, then the ready handshake: wait SI high, SO high, wait SI low, SO low
word:
	push	{lr}
	call	xfer
1:	ldrh	r2, [r9, #0x28]
	tst	r2, #4
	beq	1b
	ldr	r2, =0x100B
	strh	r2, [r9, #0x28]
2:	ldrh	r2, [r9, #0x28]
	tst	r2, #4
	bne	2b
	ldr	r2, =0x1003
	strh	r2, [r9, #0x28]
	pop	{pc}

@ ---- a request word: librfu only goes on if the adapter answered it with 0x80000000
reqword:
	push	{lr}
	call	word
	cmp	r1, #0x80000000
	beq	1f
	ldr	r2, [r11, #0x1C]
	cmp	r2, #0
	streq	r1, [r11, #0x1C]
1:	pop	{pc}

@ ---- command r1 with r2 parameters from r11 + 0xA00; reply into r11 + 0x800.
@ Returns r1 = the reply's header, r3 = its length.
cmd:
	push	{r4-r8, lr}
	mov	r4, r1
	mov	r5, r2
	ldr	r1, =0x99660000
	orr	r1, r1, r5, lsl #8
	orr	r1, r1, r4
	call	reqword
	add	r6, r11, #0xA00
	mov	r7, #0
1:	cmp	r7, r5
	bge	2f
	ldr	r1, [r6, r7, lsl #2]
	call	reqword
	add	r7, r7, #1
	b	1b
2:	mov	r1, #0x80000000
	call	word
	add	r6, r11, #0x800
	str	r1, [r6]
	mov	r8, r1, lsr #8
	and	r8, r8, #0xFF
	mov	r7, #1
3:	cmp	r7, r8
	bgt	4f
	mov	r1, #0x80000000
	call	word
	str	r1, [r6, r7, lsl #2]
	add	r7, r7, #1
	b	3b
4:	ldr	r1, [r6]
	mov	r3, r8
	pop	{r4-r8, pc}

@ ---- after a "change" command: the adapter clocks a wake-up command in; answer it.
@ Returns r1 = its header (parameters after it at r11 + 0x804).
wait_wake:
	push	{r4-r8, lr}
	add	r6, r11, #0x800
	mov	r1, #0x80000000
	str	r1, [r9, #0x20]
	ldr	r2, =0x1002		@ external clock
	strh	r2, [r9, #0x28]
	ldr	r2, =0x1082		@ ready for the adapter
	strh	r2, [r9, #0x28]
	mov	r7, #0			@ words received
	mov	r5, #0			@ 0 header, 1 parameters, 2 our answer is out
ww_loop:
1:	ldrh	r2, [r9, #0x28]
	tst	r2, #0x80
	bne	1b
2:	ldrh	r2, [r9, #0x28]		@ SI low
	tst	r2, #4
	bne	2b
	ldr	r2, =0x100A		@ SO high
	strh	r2, [r9, #0x28]
	ldr	r1, [r9, #0x20]
	cmp	r5, #2
	beq	ww_done
	str	r1, [r6, r7, lsl #2]
	add	r7, r7, #1
	cmp	r5, #0
	bne	ww_param
	mov	r8, r1, lsr #8
	and	r8, r8, #0xFF		@ parameters to come
	and	r4, r1, #0xFF
	add	r4, r4, #0x80
	ldr	r2, =0x99660000
	orr	r4, r4, r2		@ our answer: the command + 0x80
	mov	r5, #1
	cmp	r8, #0
	bne	ww_more
	b	ww_answer
ww_param:
	subs	r8, r8, #1
	bne	ww_more
ww_answer:
	str	r4, [r9, #0x20]
	mov	r5, #2
	b	ww_rearm
ww_more:
	mov	r1, #0x80000000
	str	r1, [r9, #0x20]
ww_rearm:
3:	ldrh	r2, [r9, #0x28]		@ SI high
	tst	r2, #4
	beq	3b
	ldr	r2, =0x1002		@ SO low
	strh	r2, [r9, #0x28]
	ldr	r2, =0x1082
	strh	r2, [r9, #0x28]
	b	ww_loop
ww_done:
3:	ldrh	r2, [r9, #0x28]
	tst	r2, #4
	beq	3b
	ldr	r2, =0x1002
	strh	r2, [r9, #0x28]
	mov	r2, #0
	str	r2, [r9, #0x20]
	ldr	r2, =0x1003		@ the clock is ours again
	strh	r2, [r9, #0x28]
	ldr	r1, [r6]
	pop	{r4-r8, pc}

@ ---- wait for the next vblank
frame:
1:	ldrh	r2, [r0, #6]
	cmp	r2, #160
	beq	1b
2:	ldrh	r2, [r0, #6]
	cmp	r2, #160
	bne	2b
	bx	lr

@ ---- librfu's Sio32ID login as clock master; returns r1 = the adapter's ID (0x8001)
login:
	push	{r3-r8, lr}
	mov	r3, #0			@ count
	mov	r4, #0			@ send_id
	mov	r5, #0			@ recv_id
	mov	r6, #0			@ last_id
	mov	r7, #0			@ tries
	mov	r1, #0
login_loop:
	call	xfer
	mov	r2, r1, lsl #16
	mov	r2, r2, lsr #16		@ the adapter's echo
	mov	r8, r1, lsr #16		@ the adapter's word
	cmp	r6, #0
	bne	login_next
	cmp	r2, r5
	movne	r3, #0
	bne	login_next
	cmp	r3, #4
	movge	r6, r8
	bge	login_next
	mvn	r2, r4
	mov	r2, r2, lsl #16
	mov	r2, r2, lsr #16
	cmp	r5, r2
	bne	login_next
	mvn	r2, r5
	mov	r2, r2, lsl #16
	mov	r2, r2, lsr #16
	cmp	r8, r2
	addeq	r3, r3, #1
login_next:
	cmp	r3, #4
	ldrge	r4, =0x8001
	bge	1f
	adr	r2, nintendo
	add	r2, r2, r3, lsl #1
	ldrh	r4, [r2]
1:	mvn	r5, r8
	mov	r5, r5, lsl #16
	mov	r5, r5, lsr #16
	orr	r1, r4, r5, lsl #16
	cmp	r6, #0
	bne	login_done
	add	r7, r7, #1
	cmp	r7, #200
	blt	login_loop
login_done:
	mov	r1, r6
	pop	{r3-r8, pc}

	.align	2
nintendo:
	.hword	0x494e, 0x544e, 0x4e45, 0x4f44

	.ltorg
