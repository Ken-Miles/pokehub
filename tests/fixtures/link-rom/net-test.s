@ Homebrew GBA test program for the network cable (tests/emulator-core.test.ts).
@ Our own code, no game data. It talks the way Gen 3's link layer does
@ (pokeemerald src/link.c): blocks of 9 multiplayer transfers, the parent
@ starting one block per frame; transfer 0 carries each GBA's 16-bit sum of
@ every word it received in the previous block, transfers 1..8 carry data.
@   parent data words: 0x1000 | n, child data words: 0x2000 | n (n counts up, 12 bits)
@ Results at 0x02000000: [0] role (0 parent, 4 child), [1] blocks done,
@ [2] checksum mismatches, [3] words logged, then from 0x02000100 one word per
@ data transfer: SIOMULTI0 | SIOMULTI1 << 16 (first 1024).
@ Build: tests/fixtures/link-rom/build.sh

	.arm
	.text
	.global _start
_start:
	b	main			@ 0x00: jump over the cartridge header
	.fill	0x9c, 1, 0		@ 0x04: logo (not checked without a BIOS)
	.ascii	"HUBNETTEST\0\0"	@ 0xa0: title
	.ascii	"ZHNE"			@ 0xac: game code (not a real game's)
	.ascii	"00"			@ 0xb0: maker
	.byte	0x96			@ 0xb2: fixed value
	.fill	0x0d, 1, 0		@ 0xb3..0xbf

main:
	ldr	r0, =0x04000000		@ I/O registers
	ldr	r3, =0x02000000		@ results
	mov	r1, #0
	str	r1, [r3, #4]
	str	r1, [r3, #8]
	str	r1, [r3, #12]
	add	r12, r0, #0x134		@ RCNT = 0: serial port in normal/multiplayer use
	strh	r1, [r12]
	add	r2, r0, #0x128		@ r2 = SIOCNT
	ldr	r1, =0x6003		@ multiplayer, 115200 baud, interrupt flag on each transfer
	strh	r1, [r2]
	add	r7, r0, #0x120		@ r7 = SIOMULTI0
	mov	r1, #0
	strh	r1, [r7, #0x0a]		@ SIOMLT_SEND: the first block's checksum slot
	ldrh	r1, [r2]
	and	r5, r1, #0x04		@ SI: 0 = parent, 4 = child
	str	r5, [r3]
	mov	r4, #0			@ position in the block
	mov	r6, #0			@ data words sent
	mov	r8, #0			@ sum of this block's received words
	mov	r9, #0			@ 1 once a whole block has been summed
	add	r12, r0, #0x200		@ r12 = IE, IF at +2

loop:
	cmp	r5, #0
	bne	wait_done		@ the child just waits for the parent's transfers
	cmp	r4, #0
	bne	start
vblank_leave:
	ldrh	r1, [r0, #6]		@ VCOUNT
	cmp	r1, #160
	beq	vblank_leave
vblank_enter:
	ldrh	r1, [r0, #6]
	cmp	r1, #160
	bne	vblank_enter
start:
	ldrh	r1, [r2]
	orr	r1, r1, #0x80		@ start
	strh	r1, [r2]

wait_done:
	ldrh	r1, [r12, #2]		@ IF
	tst	r1, #0x80		@ serial
	beq	wait_done
	mov	r1, #0x80
	strh	r1, [r12, #2]		@ acknowledge
	ldrh	r10, [r7]		@ SIOMULTI0 (parent)
	ldrh	r11, [r7, #2]		@ SIOMULTI1 (child)
	cmp	r4, #0
	bne	data

	cmp	r9, #0			@ checksum slot: both words must match our own sum
	beq	checked
	mov	r1, r8, lsl #16
	mov	r1, r1, lsr #16
	ldr	r14, [r3, #8]
	cmp	r10, r1
	addne	r14, r14, #1
	cmp	r11, r1
	addne	r14, r14, #1
	str	r14, [r3, #8]
checked:
	mov	r8, #0
	mov	r9, #1
	b	next

data:
	add	r8, r8, r10
	add	r8, r8, r11
	ldr	r14, [r3, #12]
	cmp	r14, #1024
	bge	next
	add	r1, r3, #0x100
	orr	r10, r10, r11, lsl #16
	str	r10, [r1, r14, lsl #2]
	add	r14, r14, #1
	str	r14, [r3, #12]

next:
	add	r4, r4, #1
	cmp	r4, #9
	moveq	r4, #0
	ldreq	r1, [r3, #4]
	addeq	r1, r1, #1
	streq	r1, [r3, #4]
	cmp	r4, #0			@ what to send in the next transfer
	moveq	r1, r8, lsl #16
	moveq	r1, r1, lsr #16		@ the checksum
	beq	send
	add	r6, r6, #1
	mov	r1, r6, lsl #20
	mov	r1, r1, lsr #20		@ or the next data word
	cmp	r5, #0
	orreq	r1, r1, #0x1000
	orrne	r1, r1, #0x2000
send:
	strh	r1, [r7, #0x0a]		@ SIOMLT_SEND
	b	loop

	.ltorg
