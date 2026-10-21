@ Homebrew GBA test program for the link cable (tests/emulator-core.test.ts).
@ Our own code, no game data. Every linked GBA runs this same file:
@   1. switch the serial port to multiplayer mode and wait until all GBAs are ready
@   2. 16 rounds: the parent sends 0x1000+n, the child 0x2000+n; the parent starts
@      one transfer per frame, the child waits until it sees the parent's word
@   3. after each round, store SIOMULTI0 | SIOMULTI1 << 16 in work RAM
@ Results at 0x02000000: [0] role (0 parent, 4 child), [1] rounds done, [2..17] words.
@ Build: tests/fixtures/link-rom/build.sh

	.arm
	.text
	.global _start
_start:
	b	main			@ 0x00: jump over the cartridge header
	.fill	0x9c, 1, 0		@ 0x04: logo (not checked without a BIOS)
	.ascii	"HUBLINKTEST\0"		@ 0xa0: title
	.ascii	"ZHLE"			@ 0xac: game code (not a real game's)
	.ascii	"00"			@ 0xb0: maker
	.byte	0x96			@ 0xb2: fixed value
	.fill	0x0d, 1, 0		@ 0xb3..0xbf

main:
	ldr	r0, =0x04000000		@ I/O registers
	add	r2, r0, #0x128		@ r2 = SIOCNT
	add	r7, r0, #0x120		@ r7 = SIOMULTI0
	ldr	r3, =0x02000000		@ r3 = results
	mov	r1, #0
	str	r1, [r3, #4]
	add	r12, r0, #0x134		@ RCNT = 0: serial port in normal/multiplayer use
	strh	r1, [r12]
	ldr	r1, =0x2003		@ multiplayer mode, 115200 baud
	strh	r1, [r2]

wait_ready:
	ldrh	r1, [r2]
	tst	r1, #0x08		@ SD: every GBA on the cable is ready
	beq	wait_ready
	and	r5, r1, #0x04		@ SI: 0 = parent, 1 = child
	str	r5, [r3]
	mov	r4, #0			@ round

loop:
	cmp	r4, #16
	bge	done
	cmp	r5, #0
	moveq	r6, #0x1000
	movne	r6, #0x2000
	add	r6, r6, r4
	strh	r6, [r7, #0x0a]		@ SIOMLT_SEND
	bne	child			@ flags still from the role test

parent:
vblank_leave:
	ldrh	r1, [r0, #6]		@ VCOUNT
	cmp	r1, #160
	beq	vblank_leave
vblank_enter:
	ldrh	r1, [r0, #6]
	cmp	r1, #160
	bne	vblank_enter
	ldrh	r1, [r2]
	orr	r1, r1, #0x80		@ start
	strh	r1, [r2]
busy:
	ldrh	r1, [r2]
	tst	r1, #0x80
	bne	busy
	b	record

child:
	mov	r8, #0x1000
	add	r8, r8, r4
child_wait:
	ldrh	r1, [r7]
	cmp	r1, r8
	bne	child_wait

record:
	ldrh	r1, [r7]		@ SIOMULTI0 (parent)
	ldrh	r9, [r7, #2]		@ SIOMULTI1 (child)
	orr	r1, r1, r9, lsl #16
	add	r10, r3, #8
	str	r1, [r10, r4, lsl #2]
	add	r4, r4, #1
	str	r4, [r3, #4]
	b	loop

done:
	b	done

	.ltorg
