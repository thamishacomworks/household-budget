// Monthly PDF export.
// No external libraries or internet connection required.

(() => {
  const encoder = new TextEncoder();

  function makePDF(images, width, height) {
    const parts = [];
    const offsets = [0];

    let length = 0;

    function add(value) {
      const bytes = typeof value === "string"
        ? encoder.encode(value)
        : value;

      parts.push(bytes);
      length += bytes.length;
    }

    function object(id, body) {
      offsets[id] = length;
      add(`${id} 0 obj\n${body}\nendobj\n`);
    }

    add("%PDF-1.4\n");

    object(
      1,
      "<< /Type /Catalog /Pages 2 0 R >>"
    );

    const kids = images
      .map((_, index) => `${3 + index * 3} 0 R`)
      .join(" ");

    object(
      2,
      `<< /Type /Pages /Count ${images.length} /Kids [${kids}] >>`
    );

    images.forEach((image, index) => {
      const pageId = 3 + index * 3;
      const imageId = pageId + 1;
      const contentId = pageId + 2;

      object(
        pageId,
        `<< /Type /Page /Parent 2 0 R ` +
        `/MediaBox [0 0 595.28 841.89] ` +
        `/Resources << /XObject << /Photo ${imageId} 0 R >> >> ` +
        `/Contents ${contentId} 0 R >>`
      );

      offsets[imageId] = length;

      add(
        `${imageId} 0 obj\n` +
        `<< /Type /XObject /Subtype /Image ` +
        `/Width ${width} /Height ${height} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 ` +
        `/Filter /DCTDecode /Length ${image.length} >>\n` +
        `stream\n`
      );

      add(image);
      add("\nendstream\nendobj\n");

      const commands =
        "q\n595.28 0 0 841.89 0 0 cm\n/Photo Do\nQ\n";

      object(
        contentId,
        `<< /Length ${encoder.encode(commands).length} >>\n` +
        "stream\n" +
        commands +
        "endstream"
      );
    });

    const xref = length;

    add(
      `xref\n0 ${offsets.length}\n` +
      "0000000000 65535 f \n"
    );

    for (let index = 1; index < offsets.length; index++) {
      add(
        `${String(offsets[index]).padStart(10, "0")} 00000 n \n`
      );
    }

    add(
      `trailer\n` +
      `<< /Size ${offsets.length} /Root 1 0 R >>\n` +
      `startxref\n${xref}\n%%EOF`
    );

    return new Blob(parts, {
      type: "application/pdf"
    });
  }

  function createReport(month, monthKey, currency) {
    const WIDTH = 1191;
    const HEIGHT = 1684;
    const SCALE = 1.5;

    const images = [];

    let canvas;
    let context;
    let y;

    const format = (value) => {
      return currency + " " +
        (value / 100).toLocaleString("en", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2
        });
    };

    const [year, monthNumber] = monthKey
      .split("-")
      .map(Number);

    const title = new Date(
      year,
      monthNumber - 1,
      1
    ).toLocaleDateString("en", {
      year: "numeric",
      month: "long"
    });

    const generated = new Date().toLocaleString();

    const income = month.contributions.reduce(
      (sum, item) => sum + item.amount,
      0
    );

    const expenses = month.expenses.reduce(
      (sum, item) => sum + item.amount,
      0
    );

    const balance = month.opening + income - expenses;

    function text(
      value,
      x,
      top,
      size = 14,
      bold = false,
      color = "#263c34"
    ) {
      context.font =
        `${bold ? "bold " : ""}${size}px Arial, sans-serif`;

      context.fillStyle = color;
      context.fillText(String(value), x, top);
    }

    function finishPage() {
      if (!canvas) return;

      text(
        "Household Budget | " + title,
        48,
        1064,
        10,
        false,
        "#788477"
      );

      text(
        "Page " + (images.length + 1),
        690,
        1064,
        10,
        false,
        "#788477"
      );

      const encoded = canvas
        .toDataURL("image/jpeg", 0.93)
        .split(",")[1];

      images.push(
        Uint8Array.from(
          atob(encoded),
          (character) => character.charCodeAt(0)
        )
      );
    }

    function newPage() {
      finishPage();

      canvas = document.createElement("canvas");

      canvas.width = WIDTH;
      canvas.height = HEIGHT;

      context = canvas.getContext("2d");

      if (!context) {
        throw new Error(
          "PDF drawing is unavailable in this browser."
        );
      }

      context.scale(SCALE, SCALE);

      context.fillStyle = "white";

      context.fillRect(
        0,
        0,
        WIDTH / SCALE,
        HEIGHT / SCALE
      );

      context.textBaseline = "top";

      text(
        "HOUSEHOLD BUDGET",
        48,
        42,
        24,
        true,
        "#164638"
      );

      text(
        "Monthly report — " + title,
        48,
        78,
        16,
        true
      );

      text(
        "Generated: " + generated,
        48,
        104,
        10,
        false,
        "#788477"
      );

      y = 143;
    }

    function ensureSpace(height) {
      if (y + height > 1020) {
        newPage();
      }
    }

    function heading(value) {
      ensureSpace(78);

      context.fillStyle = "#edf4e7";
      context.fillRect(48, y, 698, 32);

      text(
        value,
        60,
        y + 8,
        14,
        true,
        "#164638"
      );

      y += 45;
    }

    function row(label, value, bold = false) {
      context.font =
        `${bold ? "bold " : ""}14px Arial, sans-serif`;

      const lines = [];
      let line = "";

      const cleanLabel = String(label)
        .replace(/\s+/g, " ");

      for (const character of cleanLabel) {
        if (
          context.measureText(line + character).width > 435 &&
          line
        ) {
          lines.push(line);
          line = "";
        }

        line += character;
      }

      lines.push(line);

      const height = Math.max(
        30,
        lines.length * 20 + 12
      );

      ensureSpace(height);

      lines.forEach((part, index) => {
        text(
          part,
          58,
          y + index * 20,
          14,
          bold
        );
      });

      context.font =
        `${bold ? "bold " : ""}14px Arial, sans-serif`;

      const valueWidth = context.measureText(value).width;

      text(
        value,
        736 - valueWidth,
        y,
        14,
        bold
      );

      context.strokeStyle = "#e4e8df";
      context.beginPath();

      context.moveTo(48, y + height - 6);
      context.lineTo(746, y + height - 6);

      context.stroke();

      y += height;
    }

    const sorted = (records) => {
      return [...records].sort(
        (a, b) => a.date.localeCompare(b.date)
      );
    };

    newPage();

    heading("Monthly summary");

    row("Opening balance", format(month.opening));
    row("Total contributions", format(income));
    row("Total expenses", format(expenses));

    row(
      balance < 0 ? "Amount short" : "Available balance",
      format(balance),
      true
    );

    y += 16;

    const people = new Map();

    for (const item of month.contributions) {
      const key = item.name
        .trim()
        .toLocaleLowerCase();

      const person = people.get(key) || {
        name: item.name,
        amount: 0
      };

      person.amount += item.amount;
      people.set(key, person);
    }

    heading("Contributions by person");

    if (!people.size) {
      row("No contributions recorded", "—");
    }

    for (const person of people.values()) {
      row(person.name, format(person.amount));
    }

    y += 16;

    heading("Contribution details");

    if (!month.contributions.length) {
      row("No contributions recorded", "—");
    }

    for (const item of sorted(month.contributions)) {
      row(
        `${item.name} (${item.date})`,
        format(item.amount)
      );
    }

    y += 16;

    const sections = [
      [
        "Monthly bills",
        month.expenses.filter(
          (item) => item.category !== "extra"
        )
      ],
      [
        "Additional expenses",
        month.expenses.filter(
          (item) => item.category === "extra"
        )
      ]
    ];

    for (const [label, records] of sections) {
      heading(label);

      if (!records.length) {
        row("No expenses recorded", "—");
      }

      for (const item of sorted(records)) {
        row(
          `${item.name} (${item.date})`,
          format(item.amount)
        );
      }

      y += 16;
    }

    finishPage();

    return makePDF(images, WIDTH, HEIGHT);
  }

  const button = document.getElementById("downloadReport");

  button.addEventListener("click", async () => {
    if (!ready) return;

    const monthKey = selectedMonth;

    button.disabled = true;

    try {
      await saveQueue;

      const saved = await readSavedState();

      const snapshot = saved
        ? validateState(saved)
        : defaultState();

      const month = snapshot.months[monthKey] || emptyMonth();

      const pdf = createReport(
        month,
        monthKey,
        snapshot.currency
      );

      const url = URL.createObjectURL(pdf);
      const link = document.createElement("a");

      link.href = url;

      link.download =
        `household-budget-report-${monthKey}.pdf`;

      document.body.appendChild(link);

      link.click();
      link.remove();

      setTimeout(() => {
        URL.revokeObjectURL(url);
      }, 60000);

      toast(
        "PDF created. Check Downloads or Files, then share it."
      );
    } catch (error) {
      appAlert(
        "Unable to create the PDF.\n\n" +
        error.message
      );
    } finally {
      button.disabled = false;
    }
  });
})();