import type { DynastyNewsItem } from '@/lib/dynasty'

export type NewsFeed = 'news' | 'my-news'
export type DynastyNewsCache = { news: DynastyNewsItem[]; myNews: DynastyNewsItem[]; settledFeeds?: NewsFeed[] }

export function newsFeedReady(cache: DynastyNewsCache | null | undefined, feed: NewsFeed): boolean {
    const items = feed === 'news' ? cache?.news : cache?.myNews
    return Boolean(cache?.settledFeeds?.includes(feed) || items?.length)
}

export function updateNewsCache(previous: DynastyNewsCache | null, feed: NewsFeed, items: DynastyNewsItem[]): DynastyNewsCache {
    return {
        news: feed === 'news' ? items : previous?.news ?? [],
        myNews: feed === 'my-news' ? items : previous?.myNews ?? [],
        settledFeeds: [...new Set([...(previous?.settledFeeds ?? []), feed])],
    }
}
