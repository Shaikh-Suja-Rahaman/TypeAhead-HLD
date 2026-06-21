/**
 * Frontend Application Logic
 */

const searchInput = document.getElementById("searchInput");
const autocompleteResults = document.getElementById("autocompleteResults");
const searchWrapper = document.getElementById("searchWrapper");
const overlay = document.getElementById("overlay");
const searchBtn = document.getElementById("searchBtn");
const luckyBtn = document.getElementById("luckyBtn");

const TYPING_DELAY_MS = 150;
let highlightedIndex = -1;
let currentOptions = [];

function createDebounce(callback, delay) {
  let timeoutId;
  return (...args) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => callback(...args), delay);
  };
}

function encodeSafeHtml(str) {
  return str.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

function applyHighlight(rawText, userPrefix) {
  if (userPrefix && rawText.toLowerCase().startsWith(userPrefix.toLowerCase())) {
    const matchedSegment = encodeSafeHtml(rawText.slice(0, userPrefix.length));
    const remainingSegment = encodeSafeHtml(rawText.slice(userPrefix.length));
    return `<span class="sugg-match">${matchedSegment}</span>${remainingSegment}`;
  }
  return encodeSafeHtml(rawText);
}

const SEARCH_ICON_SVG = `<svg class="list-icon" focusable="false" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"></path></svg>`;

function displayOptions(prefix, items) {
  currentOptions = items;
  highlightedIndex = -1;
  
  if (items.length > 0) {
    searchWrapper.classList.add("active");
    autocompleteResults.innerHTML = items
      .map(
        (item, idx) =>
          `<li role="option" data-idx="${idx}" data-val="${encodeSafeHtml(item)}">` +
          SEARCH_ICON_SVG + `<span class="sugg-text"><span>${applyHighlight(item, prefix)}</span></span></li>`
      )
      .join("");
  } else {
    searchWrapper.classList.remove("active");
    autocompleteResults.innerHTML = "";
  }
}

const retrieveAutocompleteOptions = createDebounce(async (prefixStr) => {
  if (!prefixStr) {
    displayOptions("", []);
    return;
  }
  try {
    const response = await fetch(`/suggest?q=${encodeURIComponent(prefixStr)}`);
    const payload = await response.json();
    if (searchInput.value.trim() === prefixStr) {
      displayOptions(prefixStr, payload.suggestions ?? []);
    }
  } catch (error) {
    console.error("Failed to load suggestions.");
  }
}, TYPING_DELAY_MS);

searchInput.addEventListener("input", () => retrieveAutocompleteOptions(searchInput.value.trim()));

searchInput.addEventListener("focus", () => {
  if (searchInput.value.trim().length > 0 && currentOptions.length > 0) {
    searchWrapper.classList.add("active");
  }
});

overlay.addEventListener("click", () => {
  searchWrapper.classList.remove("active");
});

searchInput.addEventListener("keydown", (event) => {
  const listItems = [...autocompleteResults.querySelectorAll("li")];
  if (event.key === "ArrowDown" && listItems.length) {
    event.preventDefault();
    highlightedIndex = (highlightedIndex + 1) % listItems.length;
  } else if (event.key === "ArrowUp" && listItems.length) {
    event.preventDefault();
    highlightedIndex = (highlightedIndex - 1 + listItems.length) % listItems.length;
  } else if (event.key === "Enter") {
    const selectedText = highlightedIndex >= 0 ? currentOptions[highlightedIndex] : searchInput.value.trim();
    if (selectedText) executeSearch(selectedText);
    return;
  } else {
    return;
  }
  listItems.forEach((node, idx) => node.setAttribute("aria-selected", idx === highlightedIndex));
});

autocompleteResults.addEventListener("click", (event) => {
  const node = event.target.closest("li");
  if (node) executeSearch(node.dataset.val);
});

async function executeSearch(searchString) {
  searchInput.value = searchString;
  searchWrapper.classList.remove("active");
  try {
    await fetch("/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: searchString }),
    });
  } catch (e) {
    console.error("Search request failed to dispatch", e);
  }
}

searchBtn.addEventListener("click", () => {
  const query = searchInput.value.trim();
  if (query) executeSearch(query);
});

luckyBtn.addEventListener("click", () => {
  const query = searchInput.value.trim();
  if (query) executeSearch(query);
});

const trendingList = document.getElementById("trendingList");
const TREND_ICON_SVG = `<svg class="trend-icon" focusable="false" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M16 6l2.29 2.29-4.88 4.88-4-4L2 16.59 3.41 18l6-6 4 4 6.3-6.29L22 12V6z"></path></svg>`;

async function fetchTrendingQueries() {
  if (!trendingList) return;
  try {
    const response = await fetch("/trending");
    const payload = await response.json();
    trendingList.innerHTML = (payload.trending ?? [])
      .map(
        (item) =>
          `<li data-val="${encodeSafeHtml(item.query)}">` +
          TREND_ICON_SVG +
          `<span class="trend-text">${encodeSafeHtml(item.query)}</span>` +
          `</li>`
      )
      .join("");
  } catch {
    trendingList.innerHTML = "<li>Failed to load trends</li>";
  }
}

if (trendingList) {
  trendingList.addEventListener("click", (event) => {
    const node = event.target.closest("li");
    if (node) {
      executeSearch(node.dataset.val);
    }
  });
  fetchTrendingQueries();
}
