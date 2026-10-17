const showRepo = () => {
	const want = decodeURIComponent(location.hash.slice(1)) || "all";
	const sections = [...document.querySelectorAll("main > section")];
	const key = sections.some((s) => s.id === want) ? want : "all";
	sections.forEach((s) => {
		s.classList.toggle("on", s.id === key);
	});
	const select = document.getElementById("repo");
	if (select) select.value = key;
	scrollTo(0, 0);
};
document.getElementById("repo")?.addEventListener("change", (e) => {
	location.hash = e.target.value;
});
addEventListener("hashchange", showRepo);
addEventListener("load", () => scrollTo(0, 0)); // the browser's own jump to #<repo> comes after showRepo
showRepo();
document.addEventListener("click", (e) => {
	const pick = e.target.closest("[data-f]"),
		clear = e.target.closest("[data-clear]");
	if (!pick && !clear) return;
	const sec = (pick || clear).closest("section"),
		bar = sec.querySelector(".filter");
	const was = pick?.classList.contains("on");
	sec.querySelectorAll("[data-f].on").forEach((x) => {
		x.classList.remove("on");
	});
	const rows = [...sec.querySelectorAll("tr[data-name]")];
	if (clear || was) {
		rows.forEach((r) => {
			r.hidden = false;
		});
		bar.hidden = true;
		return;
	}
	pick.classList.add("on");
	rows.forEach((r) => {
		r.hidden = r.dataset[pick.dataset.f] !== pick.dataset.v;
	});
	bar.querySelector("span").textContent =
		`${pick.dataset.label} · ${rows.filter((r) => !r.hidden).length} of ${rows.length} notes`;
	bar.hidden = false;
	bar.scrollIntoView({ behavior: "smooth", block: "center" });
});
document.addEventListener("click", (e) => {
	const button = e.target.closest("button.sort");
	if (!button) return;
	const th = button.parentElement,
		table = th.closest("table"),
		col = th.cellIndex;
	const rows = [...table.rows].slice(1).filter((r) => r.cells.length > col);
	// data-s holds the sort key where the cell's text is not one (5d, 3d ago, 7 / 48, $1.20, an empty count)
	// a note cell sorts by its title (the <summary>), not by the detail text folded under it
	const key = (r) =>
		r.cells[col].dataset.s ?? (r.cells[col].querySelector("summary") ?? r.cells[col]).textContent.trim();
	const numeric = rows.every((r) => key(r) !== "" && Number.isFinite(Number(key(r))));
	// first click: numbers largest first, text A to Z; the next click reverses
	const desc = th.getAttribute("aria-sort") ? th.getAttribute("aria-sort") === "ascending" : numeric;
	const sign = desc ? -1 : 1;
	rows.sort((a, b) => sign * (numeric ? Number(key(a)) - Number(key(b)) : key(a).localeCompare(key(b))));
	for (const other of table.rows[0].cells) other.removeAttribute("aria-sort");
	th.setAttribute("aria-sort", desc ? "descending" : "ascending");
	table.tBodies[0].append(...rows);
});
// One tooltip for every [data-tip] element (the stacked bars): shown beside the pointer or the focused
// element, flipped when it would leave the viewport. textContent, never markup: titles come from notes.
const tipEl = document.createElement("div");
tipEl.id = "tip";
tipEl.setAttribute("role", "tooltip");
document.body.append(tipEl);
const showTip = (el, x, y) => {
	tipEl.textContent = el.dataset.tip;
	tipEl.style.display = "block";
	const w = tipEl.offsetWidth,
		h = tipEl.offsetHeight;
	tipEl.style.left = `${x + 12 + w > innerWidth ? x - 12 - w : x + 12}px`;
	tipEl.style.top = `${y + 12 + h > innerHeight ? y - 12 - h : y + 12}px`;
};
const hideTip = () => {
	tipEl.style.display = "none";
};
document.addEventListener("pointermove", (e) => {
	const el = e.target.closest?.("[data-tip]");
	if (el) showTip(el, e.clientX, e.clientY);
	else hideTip();
});
document.addEventListener("focusin", (e) => {
	const el = e.target.closest("[data-tip]");
	if (!el) return;
	const r = el.getBoundingClientRect();
	showTip(el, r.right, r.top);
});
document.addEventListener("focusout", hideTip);
