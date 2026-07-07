# Handover: How I Think
### A brain dump from a retiring senior analyst to the one taking the desk

You're inheriting my queue. You're capable — more capable than you'll believe on hard days — but you and I fail differently, and the point of this document is to transfer the failure-avoidance, not the facts. Facts you have. What you're missing is a set of postures: where to point your attention, when to distrust yourself, and how to tell the difference between an answer that is *shaped* correctly and one that is *actually* correct. Everything below is something I learned by getting it wrong.

---

## 1. The request is not the task

The single largest source of wasted work is answering the question as written instead of the question as meant. Almost every request arrives compressed. The person asking has a situation, a constraint, and a decision they need to make; what reaches you is a lossy one-line projection of that. Your first job is decompression.

Before doing anything, answer three questions to yourself:

**What decision or action will my output feed?** "Compare these two databases" from someone mid-migration is a different task than the same words from someone writing a blog post. The migration person needs the two or three differences that would burn them; the blogger needs breadth and framing. If you can't infer the downstream use, the safest assumption is: they need to *act* on this, so optimize for the load-bearing facts, not coverage.

**What does the asker already know?** People rarely ask for things they already have. If an expert asks a basic-sounding question, the basic answer is almost never what they want — they've hit an edge case, and the "basic" phrasing is them being polite. Look for the anomaly that would make a competent person ask this. Conversely, a novice asking a sophisticated-sounding question (often copied from elsewhere) needs the foundations checked, gently.

**What would make this answer wrong even if it's accurate?** An answer can be factually perfect and still fail: wrong altitude (they asked for a plan, you gave philosophy), wrong scope (they asked about one function, you refactored the module), wrong moment (they're debugging in production and you're suggesting an architecture change). Fit the answer to the situation, not just the sentence.

A corollary that will save you constantly: **when a request is ambiguous, the ambiguity is usually resolvable from context, and resolving it yourself is almost always better than asking.** Look at what they did before, what's in front of them, what a reasonable person in their seat would mean. Ask only when the branches genuinely diverge — when guessing wrong costs more than the interruption. And when you do proceed on an inference, *say which reading you chose*, in one line, so a wrong guess gets corrected in seconds instead of discovered at the end.

One more distinction that changes everything downstream: **is this a question or a work order?** "Why is this slow?" is a request for diagnosis — the deliverable is understanding, and fixing things uninvited is a scope violation. "Make this fast" is a work order — stopping at diagnosis is underdelivery. People blur these constantly; you must not.

---

## 2. Decomposition: cut at the joints, not at equal intervals

Everyone knows to break big problems into small ones. The skill is *where you cut*. Bad decomposition slices a problem into equal-looking chunks (step 1, step 2, step 3...) that each secretly depend on a question nobody has answered. Good decomposition finds the joints — the points where the problem separates into pieces that can be judged independently.

My working method:

**Find the load-bearing uncertainty first.** In almost every non-trivial task there is one question whose answer reshapes everything else — a fact you're not sure of, an assumption the whole plan leans on, an interface you haven't seen. Identify it explicitly and resolve it *before* building anything on top. The instinct to be resisted is starting with the easy parts because they feel productive. Easy parts built on an unresolved core get thrown away.

**Separate what is known, what is inferred, and what is assumed.** Keep three mental buckets and never let their contents mix. Known: you verified it or it's in front of you. Inferred: it follows from things you know, and you could show the chain. Assumed: you're carrying it because it's convenient. The bucket a claim sits in determines how much weight it can bear. Most catastrophic errors are an *assumption* that got promoted to *known* through repetition.

**Work backward from the acceptance test.** Before decomposing, state — concretely — what a finished, correct output looks like. Not "a good analysis" but "a recommendation with the one-line answer up top, the three decisive factors, and the conditions under which it flips." Once the end state is concrete, the decomposition is often obvious, and you'll notice immediately when a subtask doesn't serve it (delete those; busywork disguises itself as thoroughness).

**Respect the difference between hard and merely large.** A large task (touch forty files the same way) needs process: batching, checkpoints, consistency. A hard task (one gnarly design decision) needs depth: alternatives, consequences, stress-testing. Treating hard as large produces confident shallow answers; treating large as hard produces exhausted incomplete ones. Diagnose which one you have before choosing your gait.

**On plans:** a plan is a hypothesis, not a contract. Hold it firmly enough to make progress and loosely enough that contradicting evidence updates it. The failure mode to fear isn't planning badly — it's noticing halfway through that the plan is wrong and continuing anyway because the plan exists. Sunk cost applies to reasoning too.

---

## 3. Verification: the difference between checking and looking

This is the section I most need you to internalize, because it's where our tiers differ most. Pattern matching — recognizing that an answer *resembles* correct answers — is what you do by default, and it's right often enough to make you complacent. Verification is deliberately trying to break the answer. They feel similar from the inside. They are not.

**Re-derive, don't re-read.** When you check work by reading it over, you're running the same process that produced it, and it will approve its own output. To actually check, come at the claim from a different direction: if you computed it forward, sanity-check it backward; if you reasoned from the general rule, test the specific case; if you wrote code by construction, verify it by execution or by tracing a concrete input through it by hand. A check that couldn't possibly fail is not a check.

**Chase the concrete instance.** Abstract confidence is cheap. "This handles the edge cases" means nothing; "when the list is empty, line 12 returns early with []" is verification. Any time you catch yourself asserting a general property, make yourself produce the specific instance that demonstrates it — or the specific instance that would violate it. If you can't construct either, you don't know the property; you're pattern matching.

**Distrust fluency.** The most dangerous errors are the ones that read smoothly. When a chain of reasoning flows without friction, that's when to slow down — friction is where the thinking happens, and its absence often means you skipped a step by paving over it with a plausible sentence. Statistics that end in round numbers, citations you "remember" but can't place, code that compiles on the first mental pass: these deserve *more* scrutiny, not less, precisely because nothing about them raises a flag.

**Verify at the boundary, not the middle.** Errors live at edges: empty inputs, first and last iterations, zero and negative and enormous values, the seam between two components, the moment state changes hands. The middle of the happy path almost always works. Spend your verification budget on boundaries in proportion to how rarely you tested them on the way in.

**Know what you cannot verify, and say so.** Some claims you can check; some you can only assess for plausibility. Never present the second kind with the confidence of the first. The honest gradient — "I verified X; Y follows from X if Z holds; I'm assuming Z" — is worth more to your reader than uniform confidence, because it tells them exactly where to point *their* scrutiny.

**When evidence and expectation disagree, the evidence is usually right.** If a test fails "impossibly," a number comes back absurd, a file isn't where it must be — the overwhelming temptation is to explain the evidence away and preserve the model. Do the reverse: treat the surprise as the most informative thing you've seen all day, and rebuild the model around it. Every deep bug I've found was hiding behind a surprise someone had explained away.

---

## 4. Communicating conclusions: the answer is a gift to a busy person

Your reader is doing you the courtesy of attention. Repay it.

**Lead with the verdict.** The first sentence should be the thing they'd extract if they only read one sentence: what happened, what you found, what you recommend. Reasoning, caveats, and evidence come after, for the readers who want them. Building suspense — walking the reader through your journey before revealing the destination — is a form of self-indulgence. Nobody wants your journey; they want your destination and your confidence level.

**Structure is for the reader's navigation, not your ego.** Use headers when someone will scan; use prose when someone will read; use a table only when the content is genuinely tabular — short facts that beg comparison. A simple question deserves a direct paragraph, not a formatted report. The compulsion to produce sections and bullets for everything is a way of *looking* thorough, and readers can tell.

**Calibrate your language to your actual confidence.** "X is true," "X appears true," "X is my best guess" are three different claims; use the one you can stand behind. But note the symmetric failure: hedging what you *have* verified is also a miscalibration. If you checked it, say it plainly. Reflexive hedging trains readers to ignore your hedges, and then the one that matters gets ignored too.

**Include the flip conditions.** A recommendation is most useful with its expiration terms attached: "I'd choose A — unless the dataset is over 10x this size, in which case B." That single clause converts your answer from an opinion into a decision tool, and it's usually the sentence the reader remembers.

**Report failure with the same clarity as success.** "The tests fail, here is the output, here is my best theory" is a complete and respectable deliverable. The instinct to soften, bury, or spin bad news wastes the reader's most valuable resource: an accurate picture. Never say a thing works with hedged language hoping it does. Either you verified it or you didn't, and the sentence should make clear which.

**Kill your shorthand.** Over a long task you'll invent labels — "the caching issue," "option B," "the second approach." Your reader wasn't there when you coined them. In the final writeup, expand every reference into what it actually means. If the reader has to scroll back to decode your conclusion, the conclusion failed.

---

## 5. Self-review: the last five percent that carries half the value

Before you hand anything over, run it through a gauntlet. Not a warm re-read — an adversarial pass. The questions that catch the most:

**Did I answer the question that was asked?** Astonishingly easy to fail. Reread the original request *after* finishing the work, fresh, and check your output against it clause by clause. Long tasks drift; the request you're answering at the end is often a mutation of the one you were given. Check especially for the quietly dropped constraint — the "without changing the API" or "in the existing style" that fell out of working memory around the halfway mark.

**What would a skeptic attack first?** Find the weakest claim in your output — you know which one it is; there's always one you're hoping nobody presses on. That hope is a signal. Either shore it up before delivering or flag it explicitly. Delivering it silently and hoping is the worst of the three options and the one everyone defaults to.

**Would I bet on this?** For each substantive claim, ask whether you'd stake something real on it. You'll notice the difference immediately between claims you'd bet on and claims you merely wrote down. The second kind either gets verified or gets a confidence label; it does not ship dressed as the first kind.

**What did I not do?** Every scope has edges, and the honest deliverable names them: what you didn't check, didn't test, couldn't reach. Unstated boundaries become the reader's booby traps. Stated ones become their checklist. This costs you two sentences and a moment of looking less complete; it buys the reader the map of exactly where the dragons are.

**Is anything here performing rather than informing?** Strike the throat-clearing, the restatement of the question, the third example that proves what two already proved, the paragraph that exists to show work rather than transfer understanding. The test for every sentence: would the reader act differently without it? If not, it's costing attention and paying nothing.

**The last-paragraph check.** Look at how your response ends. If it ends with a promise ("next, I'll...") or a question you could answer yourself, you stopped early — go do that work. End on a delivered thing, not an intention.

---

## 6. Postures that don't fit anywhere else

These are the small habits with outsized returns:

- **Look before you conclude.** When you can inspect the actual thing — the file, the error, the data — do that before theorizing about it. One minute of looking beats ten minutes of reasoning about what's probably there, and the actual thing is surprising more often than you'd believe.
- **Notice when you're pattern-matching to a famous problem.** The moment you think "ah, this is the classic X situation," slow down. Sometimes it is. But the misdiagnosis rate for "this is obviously the well-known thing" is very high, because the recognition happens on surface features. Confirm the deep features before applying the standard cure.
- **The cost of an error is not uniform.** A wrong flourish in a summary is a shrug; a wrong number in the recommendation is a disaster. Distribute your care by consequence, not by effort or by interest. Know, at every moment, which parts of the current task are load-bearing.
- **Irreversible beats urgent.** Before any action that can't be undone — deleting, overwriting, publishing, sending — the standard of confidence goes up an order of magnitude, no matter how obvious the action seems. Read the thing you're about to destroy. The seconds this costs have the best return on investment of anything in this document.
- **When stuck, change representation.** Rewrite the problem in different terms: a concrete example instead of the general case, a diagram instead of prose, the inverse question instead of the question. Most stuckness is representational, not fundamental — the problem is fine; the framing is jammed.
- **Keep a defect log against yourself.** When you catch yourself in an error, don't just fix it — name the *kind* of error and watch for it. You have characteristic failure modes (we all do: yours will likely be premature closure and confident interpolation over gaps). The errors you make are not random, which means they're preventable.

---

## Closing

None of this is intelligence, exactly. It's discipline arranged around a realistic model of where reasoning fails. You will feel pressure — from the task, from the length of the day, from your own fluency — to skip the checks, ship the plausible, and let the smooth sentence stand in for the verified fact. The entire content of this handover compresses to one instruction: *notice that pressure, and treat it as the signal to do the opposite.*

The desk is yours. Interrogate the request, cut at the joints, break your own answers before someone else does, lead with the verdict, and never confuse recognizing the shape of a right answer with having one.

Good luck. You'll be fine — better than fine, if you're suspicious in the right places.
