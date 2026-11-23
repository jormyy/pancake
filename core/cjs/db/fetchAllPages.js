"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchAllPages = fetchAllPages;
const PAGE_SIZE = 1000;
async function fetchAllPages(queryPage) {
    const rows = [];
    for (let from = 0;; from += PAGE_SIZE) {
        const { data, error } = await queryPage(from, from + PAGE_SIZE - 1);
        if (error)
            throw error;
        const page = data ?? [];
        rows.push(...page);
        if (page.length < PAGE_SIZE)
            break;
    }
    return rows;
}
