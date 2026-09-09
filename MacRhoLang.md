# MacRhoLang — a user's guide

MacRhoLang is the little language you use to **write your own commands** in a
[QuantumOS](README.md) room, and to **talk to a chain** without hand‑writing
much rholang. What you write is decided by its **body** — nothing to declare:

| body | kind | you use it as | needs a chain? |
|---|---|---|---|
| starts with `/` or `+` | **command** | `+name args` — a room command | no |
| has rholang syntax (a `!` send, a `` `powerbox` `` name, `for`/`match`/`new … in {`) | **rholang** | `$name(…)` inside a `/rholang` program | yes (an rnode) |
| anything else — plain words | **text** | `$name` — yields its body; nothing runs | no |

Most of this guide is the first kind. A **text** macro is the simplest thing of
all: `/macro define sig — Jim W., RChain` and then `$sig` is that text wherever
you put it. A **rholang** macro is Part 4.

**You do not need to know rholang to use the first half.** This guide starts
there, and when rholang shows up it is explained line by line as it appears.

The name is *Mac* (macros) + *Rho* (Rholang) — a forty‑year‑old idea from EIES,
where users wrote commands, shared them, and watched a group adopt the useful
ones. The design rationale and history are in
[RChain_Macros.md](RChain_Macros.md); this is the how‑to.

---

## Part 1 — writing a `+command` (no rholang)

### Your first macro

```
/macro define hello Hi everyone 👋
```

That is the whole definition: a **name** (`hello`) and a **body** (everything
after it). Now anyone in the room runs:

```
+hello
```

and the line `Hi everyone 👋` is sent to chat as if they typed it. `+` means
"something a person in this room wrote"; `/` means "something the app ships".

### Parameters

Put parameter names in parentheses right after the macro name, and refer to them
in the body with a `$`:

```
/macro define greet(who) Hi $who, welcome to the room!
```

```
+greet Alice
→ Hi Alice, welcome to the room!
```

The body can be more than one line — press **Shift+Enter** for a newline in the
input box, or write it in the editor (see below). A body of `/` commands runs
them in order:

```
/macro define standup(topic)  // opens a standup poll
/poll new $topic | yes, no, later
/gov say standup on "$topic" is open
```

```
+standup "Q4 budget"
```

- The `// opens a standup poll` after the signature is the macro's **doc** — it
  shows up in `/macro find` and the sidebar. It is optional.
- Quotes group an argument: `+standup "Q4 budget"` passes one topic, not two.
  `+standup topic="Q4 budget"` names it instead of giving it by position.
- `$topic` is replaced textually everywhere it appears, quotes and all — inside
  `"$topic"` it becomes the words you typed.

### A `+command` can build on other `+commands`

The body is just command lines, so it can call `+other` macros the room has
defined. That is how a room grows a vocabulary.

### Managing your macros

| command | does |
|---|---|
| `/macro list` | every macro in the room |
| `/macro show <name>` | the definition, as typed |
| `/macro find <text>` | search names, docs and bodies |
| `/macro echo <name> [args]` | show what it expands to — **runs nothing** |
| `/macro remove <name>` | remove it |
| `/macro edit <name>[(args)]` | open the editor to write / rewrite the body |

Your macros are **kept in this browser** — not per room — so one you write (or
pick up from a peer) follows you into every room you join. They are also signed
with your identity and **contributed to each room**: everyone there can use
them, and they persist for whoever picks them up. **First writer wins the
name** — only its author can change or remove it for everyone; anyone else's
`/macro remove` only hides it from their own view.

---

## Part 2 — reading a little rholang

The second half of MacRhoLang reaches a **chain** (an RChain *rnode*). To test
it you need your own rnode running — `bash scripts/localnet/run-node.sh`, then
`/rholang rnode http://127.0.0.1:40403`. A room works completely without one;
this half is opt‑in.

You will meet rholang in three places: the built‑in `$` macros, your own
rholang‑body macros, and the `/rholang` editor. Here is just enough to read
them.

> **A rholang program is processes running side by side.** `|` joins them —
> `A | B` runs `A` and `B` at the same time, and they talk over **channels**.
>
> **`new x in { … }`** makes a fresh private channel called `x` and runs the
> block with it in scope. Think "let me have a new mailbox `x`".
>
> **`` `rho:io:stdout` ``** (backticks) is a *powerbox* name — a built‑in
> service. `new out(`rho:io:stdout`) in { … }` asks for the "print to the node
> log" service and calls it `out`.
>
> **`out!("hi")`** — the `!` — **sends** `"hi"` on the channel `out`.
>
> **`for (@msg <- c) { … }`** **waits for one message** on channel `c`, binds it
> to `msg`, and runs the block. The `@` means "the message is data, not a
> channel".
>
> **`*c`** turns a channel `c` into a plain value you can send to someone else;
> **`@v`** is the reverse. You will see `*ret` a lot: "here is my reply channel,
> as a value".
>
> **`match v { pattern => proc  … }`** branches on the *shape* of `v` — like a
> `switch`. `Nil` is rholang's "nothing".
>
> **`return`** is the one channel the MacRhoLang tools read back for you. Send
> your answer there — `return!(…)` — and `/rholang read` will fetch it.

That is the whole vocabulary you need for everything below.

---

## Part 3 — the `$` capability library (built in)

These ship with the app. Run one as its own line and it is wrapped, sent, and
the answer read back for you.

```
$balance("11112VYAt8rUGNRRZX3eJdgagaAhtWTK8Js7F7X5iqddMVqyDTtYau")
→ 1000000000000
```

`$me` stands in for **your own** REV address (you need a signing key —
`/rholang key generate`):

```
$balance($me)
$transfer(10, "11112VYAt8…")
```

`$balance` is a *read* — free, no block, answered immediately. `$transfer` is a
*write* — it is signed with your key and lands in a block.

A sampling of the library (`/rholang macros` lists them all):

| macro | what it does |
|---|---|
| `$balance(addr)` · `$transfer(amount, to)` | REV — read a balance, move value |
| `$verify(@token)` · `$zfa(twists)` | check a capability / twist string is ZFA‑balanced (answered in the browser, no chain) |
| `$grant(twists)` | mint a ZFA closure as a capability |
| `$directory(name)` · `$mailbox(name)` | make a key/value directory or an inbox in the registry |
| `$issuer(currency)` · `$note(cur, n)` · `$redeem(cur, n)` | promissory‑note lifecycle |
| `$group(name)` · `$delegate(peer)` · `$trust(…)` · `$tally(…)` · `$censure(…)` | governance on `rho:gov:*` |
| `$swap(a,b,c,d)` · `$multisig(…)` · `$philosophers(a,b,c)` | structural patterns (atomic swap, N‑of‑M, dining philosophers) |

**Why the `$`:** `$` is *illegal* in rholang, so if a `$macro(…)` is ever left
unexpanded by mistake, the node rejects it loudly instead of quietly running the
wrong thing.

### Capturing the result — `as`

By default a `$` macro reports its answer for you. Add **`as <pattern> { … }`**
to grab the raw reply and do something with it instead:

```
$balance($me) as bal {
  return!(("my balance is", bal))
}
```

> `as bal { … }` becomes `for (@bal <- <the reply channel>) { … }` — "when the
> balance comes back, call it `bal` and run this block". You are writing the
> `for` receive, just without the plumbing.

`$transfer` hands the block a **`(result, error)`** pair — `result` is
`("transfer ok", amount, to)` on success and `Nil` on failure; `error` is the
other way round:

```
$transfer(50, "11112VYAt8…") as (result, error) {
  match error {
    Nil => return!(("paid", result))
    _   => return!(("failed", error))
  }
}
```

For several cases, **repeat `<pattern> { block }`** — two or more arms become a
`match`:

```
$transfer(50, "11112VYAt8…") as (ok, Nil)  { return!(("paid", ok)) }
                                (Nil, err) { return!(("failed", err)) }
```

One rule to remember: **send one value to `return`.** `return!(a, b)` is two
values and the tools will not see it — wrap them: `return!((a, b))`.

---

## Part 4 — writing a rholang‑fragment macro

If your macro's body is rholang instead of commands, it becomes a `$name(…)` you
can drop into a bigger `/rholang` program. The classic one:

```
/macro define print(expression)  // stdout one term
new stdout(`rho:io:stdout`) in { stdout!($expression) }
```

> Line by line: `new stdout(`rho:io:stdout`) in { … }` asks for the print
> service and names it `stdout`; `stdout!($expression)` sends whatever the
> caller passed in to be printed. `$expression` is MacRhoLang's parameter —
> substituted before the node ever sees it.

Now use it:

```
/rholang eval
new return in { $print("hello") | return!(42) }
```

> `$print("hello")` expands in place to the `new stdout … in { stdout!("hello") }`
> body; `| return!(42)` runs alongside it and sends `42` back so the run has an
> answer.

Arguments to a `$name(…)` fragment stay **rholang terms** — `$print("hello")`
becomes `stdout!("hello")`, keeping the quotes, because in rholang a bare
`hello` would be a variable, not text.

---

## Part 5 — `/rholang`, and the editor

| verb | does |
|---|---|
| `/rholang eval` | run a program read‑only — no signing, no block, values read straight back |
| `/rholang deploy` | sign with your key and land it in a block |
| `/rholang echo` (or `show`) | the fully‑expanded program, sending nothing — the answer to *should I sign this?* |
| `/rholang explain` | posts the program to the room's AI agent, which reads it and explains it |
| `/rholang read` | fetch the answer a past deploy sent to `return` |

`/rholang eval` and `/rholang deploy` with no program open a **live‑linted
editor**: syntax highlighting, errors as you type, **Ctrl+Enter** runs,
**Esc** cancels, and you can drop a `.rho` file on it.

**Define from the editor too.** Type a definition there —

```
define fee(amount) new revVault(`rho:rchain:revVault`), deployerId(`rho:rchain:deployerId`), ret in {
  revVault!("transfer", *deployerId, "1111FeeSink…", $amount, *ret) |
  for (@done <- ret) { return!(("fee attempt", $amount, done)) }
}
```

— and Ctrl+Enter **registers the macro** instead of deploying. `/macro define
name(x)` with no body opens the editor seeded with the signature, so you can
write and lint the body there.

### A safety net

A deploy that "succeeds" only means *accepted into a block* — the program can
still error while running (a common one: `"x" ++ Nil`, concatenating a string
with nothing). When that happens the program sends nothing to `return`, and
`/rholang read` tells you the record is a leftover from an earlier deploy rather
than showing it as your result.

---

## Part 6 — the `$` line, and `/rhoqu`

A room line that **starts with `$`** runs a *built‑in* chain macro directly, the
way `+` runs a command and `/` runs a built‑in:

```
$verify(@somelemma)                        ← answered in the browser
$balance($me)                              ← an unsigned read
$transfer(10, "1111…")                     ← opens the deploy path
$( new r in { $print("hi") | r!(1) } )     ← a whole inline program
```

A `$name` that is **one of your own macros** is *shown*, not run — you see what
it expands to, plus how to run it (`/rholang eval …` / `/rholang deploy …`) if
it is rholang. So a stray `$x` never signs a deploy, and a text macro just
prints its text.

**[`/rhoqu`](RhoQuDemo.md)** is a higher‑level surface — `process`, `new`, `|`,
`if`, `on channel`, `for` — that transpiles to `/command` strings. Use it when a
protocol is easier to describe as concurrent processes than as a command list.

---

## Cheat sheet

```
/macro define name body                    body starting / or +  → a +command
/macro define name(a, b) body              body of rholang       → a $name(…) fragment
/macro define name text                    anything else         → a $name text macro
/macro define name(a)  // what it does     doc note; body follows on the next lines
/macro edit name[(args)]                   write the body in the editor

+name args                                 run a command someone defined   ("two words" groups; k=v names)
$name  ·  $name(args)                      show what your macro expands to (does not run)
$builtin(args)                             run a built-in chain macro      ($me = your REV address)
$builtin(args) as pat { … } pat { … }      capture the reply: one arm binds, several match

/macro list · show <n> · find <re> · echo <n> [args] · remove <n>
/rholang eval | deploy | echo | explain | read
/rholang key generate                      make a signing key (needed for $me, $transfer, deploy)
```

Rholang in one breath: **`|`** side‑by‑side · **`new x in { }`** a fresh channel
· **`` `rho:…` ``** a built‑in service · **`c!(v)`** send · **`for (@x <- c) { }`**
receive one · **`*c` / `@v`** channel↔value · **`match v { p => … }`** branch ·
**`return!(one_value)`** your answer · **`Nil`** nothing.

---

**See also:** [RChain_Macros.md](RChain_Macros.md) (design & history) ·
[docs/rholang.md](docs/rholang.md) (reference detail) ·
[RhoQuDemo.md](RhoQuDemo.md), [DiningPhilosophersDemo.md](DiningPhilosophersDemo.md),
[MultisigDemo.md](MultisigDemo.md) (worked walkthroughs) ·
[User_Guide.md](User_Guide.md) (the room itself).
