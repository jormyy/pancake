import { expect, it } from 'vitest'
import { newsFeedReady, updateNewsCache } from '@/components/dynasty/news-cache'
import type { DynastyNewsItem } from '@/lib/dynasty'

it('does not call an unread personal feed empty after the public feed settles', () => {
    const snapshot = updateNewsCache(null, 'news', [])
    expect(newsFeedReady(snapshot, 'news')).toBe(true)
    expect(newsFeedReady(snapshot, 'my-news')).toBe(false)
    expect(newsFeedReady(updateNewsCache(snapshot, 'my-news', []), 'my-news')).toBe(true)
})
it('replays legacy cached rows but rejects legacy empty placeholders', () => {
    expect(newsFeedReady({ news: [], myNews: [] }, 'news')).toBe(false)
    expect(newsFeedReady({ news: [{ id: 'news' } as DynastyNewsItem], myNews: [] }, 'news')).toBe(true)
    expect(newsFeedReady({ news: [], myNews: [] }, 'my-news')).toBe(false)
})
it('retains the other feed while updating a settled feed', () => {
    const items = [{ id: 'personal' } as DynastyNewsItem]
    const previous = updateNewsCache(null, 'my-news', items)
    const next = updateNewsCache(previous, 'news', [])
    expect(next.myNews).toBe(items)
    expect(newsFeedReady(next, 'my-news')).toBe(true)
    expect(newsFeedReady(next, 'news')).toBe(true)
})
