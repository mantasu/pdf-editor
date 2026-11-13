// Copilot end to end (with the harness's stand-in for Copilot): Ask Copilot from the selection
// bar and the right-click menu, the answer streaming into a card beside the page (Markdown and
// maths rendered), Add as Comment, Ask a Question, Stop, errors, Continue in Chat, and the
// context @pdf gets from the viewer (text, selection, the text under highlights).
const { start, REPO } = require("./harness.cjs");
const { suite, dragSelect, lastEdit, selectText } = require("./lib.cjs");

suite("copilot", async (t) => {
  const h = await start({ pdf: `${REPO}/resources/example.pdf`, width: 1300, height: 760 });
  const { page, host } = h;
  const card = page.locator(".pdf-copilot");
  const until = async (condition) => {
    for (let i = 0; i < 100 && !condition(); i++) {
      await page.waitForTimeout(50);
    }
  };
  const askFromBar = async (phrase, item) => {
    await dragSelect(page, phrase);
    await page.locator('.pdf-quickbar [aria-label="Ask Copilot"]').click();
    await page.getByRole("menuitem", { name: item }).click();
  };

  // Explain: the passage and its page go to Copilot; the answer streams in, rendered.
  await askFromBar("standard PDF annotations", "Explain");
  t.check("the card opens at once", await card.isVisible());
  await until(() => host.copilot.length === 1);
  const sent = host.copilot.at(-1);
  t.check("the passage and its page are sent", sent.action === "explain" && sent.selection === "standard PDF annotations" && sent.page === 1 && sent.pageText.includes("Annotating Papers in VS Code"));
  await page.locator(".pdf-copilot .pdf-button.primary").waitFor({ timeout: 5000 });
  t.check("the Markdown answer is rendered, maths too", (await card.locator(".pdf-copilot-answer strong").count()) >= 2 && (await card.locator(".pdf-copilot-answer .pdf-math svg").count()) === 1);
  const cardBox = await card.boundingBox();
  const bounds = await page.evaluate(() => { const r = getSelection().getRangeAt(0).getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; });
  t.check("beside the passage, not over it", cardBox.x >= bounds.right || cardBox.x + cardBox.width <= bounds.left || cardBox.y >= bounds.bottom, JSON.stringify({ cardBox, bounds }));
  t.check("joined to it by a line", await page.locator(".pdf-connector").count() === 1);

  // Add as Comment: a highlight on the passage whose comment is the answer, by Copilot.
  await card.getByRole("button", { name: "Add as Comment" }).click();
  const added = lastEdit(host).annotations.at(-1);
  t.check("Add as Comment makes a highlight with the answer as its comment", lastEdit(host).label === "Add Copilot Comment" && added.kind === "highlight" && added.author === "Copilot" && added.contents.includes("$E = mc^2$") && added.rich?.some((p) => p.some((r) => r.code)));
  t.check("and opens its card", (await page.locator(".pdf-popup").isVisible()) && !(await card.isVisible()));
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // Ask a question (from the right-click menu); "fail" makes the stand-in fail.
  let at = await selectText(page, "Undo and");
  await page.mouse.click(at.x, at.y, { button: "right" });
  await page.getByRole("menuitem", { name: "Ask Copilot" }).hover();
  await page.getByRole("menuitem", { name: "Ask a Question…" }).click();
  await card.locator("textarea").fill("fail");
  await page.keyboard.press("Enter");
  await card.locator(".pdf-copilot-error").waitFor({ timeout: 5000 });
  t.check("errors show in the card", (await card.locator(".pdf-copilot-error").textContent()).includes("not available") && host.copilot.at(-1).question === "fail");
  t.check("no Add as Comment without an answer", (await card.getByRole("button", { name: "Add as Comment" }).count()) === 0);
  await card.getByRole("button", { name: "Continue in Chat" }).click();
  t.check("Continue in Chat opens @pdf with the question to edit", JSON.stringify(host.chat.at(-1)) === JSON.stringify(["@pdf fail", true]));
  await page.keyboard.press("Escape");
  t.check("Escape closes the card", !(await card.isVisible()));

  // Stop: the request is cancelled.
  const asked = host.copilot.length;
  await askFromBar("Each tool's dropdown", "Summarize");
  await until(() => host.copilot.length > asked);
  await card.getByRole("button", { name: "Stop" }).click();
  await page.waitForTimeout(300);
  t.check("Stop cancels the request", host.cancelled.has(host.copilot.at(-1).requestId));
  await page.keyboard.press("Escape");

  // What @pdf gets from the viewer.
  await selectText(page, "Comments take");
  const reply = new Promise((resolve) => {
    const before = host.log.length;
    const timer = setInterval(() => {
      const found = host.log.slice(before).find((m) => m.type === "context");
      if (found) {
        clearInterval(timer);
        resolve(found.context);
      }
    }, 50);
  });
  await host.send({ type: "request-context", requestId: 77 });
  const context = await reply;
  t.check("@pdf gets every page's text", context.pages.length === 3 && context.pages[2].includes("fillable form"));
  t.check("and the selection", context.selection?.text === "Comments take" && context.selection.page === 1);
  // Letters are placed by the browser's serif font: without Times or a metric twin (Liberation Serif), the ends drift.
  t.check("and the text under highlights", context.marks["example-highlight"] === "quick-action bar" && context.marks["example-rich"] === "bold, italic" && context.marks["example-strikeout"] === "and browsers" && context.marks["example-underline"] === "first text you post", JSON.stringify(context.marks));
  t.check("no webview errors", h.errors.length === 0, h.errors.join(" | "));
  await h.close();
});
