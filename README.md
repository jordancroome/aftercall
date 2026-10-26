# aftercall

You finish a client call. aftercall works out which client it was, lists what you said you would do and what they said they would do, and writes the follow-up email. You read it, fix it and send it yourself. It never sends anything.

It reads calls recorded by [Meetily](https://github.com/Zackriya-Solutions/meeting-minutes), a free recorder that transcribes and summarises on your own machine. Or you can hand it a transcript file.

## What you get

One markdown file per call, filed in a folder per client:

```
out/northlight/2026-10-26 Northlight Property, listing copy trial.md
```

```markdown
## I said I would
- [ ] Send Priya a written scope and fixed price for the two-week trial (by 2026-10-29)

## They said they would
- [ ] Send Jordan five recent listings (by 2026-10-28)
- [ ] Run the trial cost past Greg before signing

## Still open
- Will Priya still review approved drafts, or will agents sign off their own?

## Draft follow-up (not sent)
**To:** Priya Shah <priya@northlight.example>
**Subject:** Listing copy trial, next steps
...
```

The full example, made from the fake call in `examples/demo-call.txt`, is in `examples/output/`.

## Set up

You need Node 22.5 or newer and an Anthropic API key.

```bash
git clone https://github.com/jordancroome/aftercall
cd aftercall
npm install
cp .env.example .env            # then paste your ANTHROPIC_API_KEY into .env
cp clients.example.yaml clients.yaml
```

Edit `clients.yaml`: your name, how you write, and your clients with their contacts. A draft is only ever addressed to a contact listed there.

Try it on the fake call first:

```bash
npm run demo
```

## Use it

Every new call Meetily has recorded:

```bash
npm run aftercall
```

A transcript from somewhere else (Zoom, Otter, a phone recorder):

```bash
npm run aftercall -- --file call.txt --title "Kickoff with Acme" --date 2026-10-26
```

See what it would do without calling Claude:

```bash
npm run aftercall -- --dry
```

It remembers what it has already done (`out/.aftercall-state.json`), so you can run it on a timer. `--redo` processes everything again.

## What leaves your machine

- **From Meetily, by default: the summary only.** Meetily writes the summary on your machine. aftercall sends that summary and your client list to Claude. The word-for-word transcript stays put.
- `--use-transcript` also sends the transcript, which gives better drafts. Your call.
- **A transcript file** is sent to Claude, because that is the only way to summarise it.
- **A call whose title starts with `Private`, `Personal` or `Confidential` is never read.** Set the title when you start recording.

## How it decides

- **Which client.** Claude picks from your list or says it is not sure. Not sure goes to `out/unsorted/`. A name that is not in your list counts as not sure. Filing a call under the wrong client sends the follow-up to the wrong people, which is worse than leaving it for you to file.
- **What was promised.** Only things somebody actually said on the call. It is told never to invent a promise for you, and dates are worked out from the day of the call.
- **The email** is written in the voice you describe in `clients.yaml`.

## Tests

```bash
npm test
```

## Licence

MIT. Built by [Jordan Croome](https://www.jordancroome.com).
