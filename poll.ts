import { createClient } from "@supabase/supabase-js";
import { mkdir, stat, readFile, writeFile } from "fs/promises";
import { join } from "path";

import { PrinterConnection } from "./print";

interface TweetRow {
  tweet_id: string;
  account_id: string;
  created_at: string;
  favorite_count: number;
  full_text: string;
  retweet_count: number;
  updated_at: string;
}

// Minimal shape for storing account info
interface AccountRow {
  account_display_name: string;
  username: string;
}

// Minimal shape for storing tweets in tweets.json
interface CachedTweet {
  tweet_id: string;
  account_id: string;
  account_display_name: string;
  username: string;
  created_at: string;
  full_text: string;
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_ANON_KEY in environment variables");
}

const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const TWEETS_JSON_PATH = join(process.cwd(), "data", "tweets.json");

// Simple in-memory cache keyed by `tweet_id`
const seenTweets = new Map<string, CachedTweet>();

async function main() {
  // Make sure data/ directory exists
  await ensureDataFolder();

  // Load any previously-cached tweets from disk
  await loadCachedTweets();

  // Start an infinite polling loop
  while (true) {
    await pollForNewTweets();

    // Wait 10 seconds before checking again
    await sleep(10_000);
  }
}

/**
 * Poll the 'tweets' table from Supabase and print any newly found tweets.
 */
async function pollForNewTweets() {
  console.log("[Poll] Checking for new tweets...");

  // 1. Fetch the newest 20 tweets from 'tweets'
  const { data: tweets, error: tweetError } = await supabaseClient
    .from<TweetRow>("tweets")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(20);

  if (tweetError) {
    console.error("Supabase tweet fetch error:", tweetError);
    return;
  }

  if (!tweets) {
    console.log("No tweets found.");
    return;
  }

  // 2. For each tweet, see if we already have it in `seenTweets`
  for (const tweet of tweets) {
    if (!seenTweets.has(tweet.tweet_id)) {
      // New tweet discovered: fetch account info, print, then cache
      console.log(`[New Tweet] ${tweet.tweet_id} – not in cache yet.`);

      const accountInfo = await fetchAccountInfo(tweet.account_id);
      if (!accountInfo) {
        console.warn("Could not find account info for", tweet.account_id);
        continue;
      }

      // Print
      await printTweet(
        accountInfo.account_display_name,
        accountInfo.username,
        tweet.created_at,
        tweet.full_text
      );

      // Cache
      const cached: CachedTweet = {
        tweet_id: tweet.tweet_id,
        account_id: tweet.account_id,
        account_display_name: accountInfo.account_display_name,
        username: accountInfo.username,
        created_at: tweet.created_at,
        full_text: tweet.full_text,
      };
      seenTweets.set(tweet.tweet_id, cached);

      await writeCachedTweetsToDisk();
    }
  }
}

/**
 * Fetch display name & username from the 'account' table.
 */
async function fetchAccountInfo(account_id: string): Promise<AccountRow | null> {
  const { data, error } = await supabaseClient
    .from<AccountRow>("account")
    .select("account_display_name, username")
    .eq("account_id", account_id)
    .single();

  if (error || !data) {
    console.error("Error fetching account info:", error);
    return null;
  }
  return data;
}

/**
 * Print the tweet
 */
async function printTweet(
  displayName: string,
  username: string,
  timestamp: string,
  text: string
) {
  try {
    const printerConnection = PrinterConnection.getInstance();

    // "Open" the printer for writing
    await new Promise<void>((resolve) => printerConnection.client.open(resolve));

    // Print a line with:
    //   Display Name (bold), (@username), timestamp
    //   Then the tweet text.
    printerConnection.printer
      .font("a")
      .style("b") // bold style
      .size(1, 1)
      .text(`${displayName} (@${username})`)
      .style("normal") // back to normal
      .size(1, 1)
      .text(new Date(timestamp).toLocaleString())
      .text(text)
      .cut();

    // Send buffer, close the connection
    await printerConnection.printer.flush();
    printerConnection.client.close();
  } catch (error) {
    console.error("Error printing tweet:", error);
  }
}

/**
 * Load existing tweets from disk into `seenTweets`.
 */
async function loadCachedTweets() {
  try {
    const raw = await readFile(TWEETS_JSON_PATH, "utf8");
    const arr = JSON.parse(raw) as CachedTweet[];
    for (const t of arr) {
      seenTweets.set(t.tweet_id, t);
    }
    console.log(`Loaded ${arr.length} tweets from cache.`);
  } catch (err: any) {
    // If file not found or invalid JSON, we treat as empty
    console.log("No existing tweets.json or parse error, starting fresh.");
  }
}

/**
 * Write the in-memory tweets to disk as JSON.
 */
async function writeCachedTweetsToDisk() {
  const allTweets = Array.from(seenTweets.values());
  const serialized = JSON.stringify(allTweets, null, 2);
  await writeFile(TWEETS_JSON_PATH, serialized, "utf8");
}

/**
 * Ensure that `./data` folder exists.
 */
async function ensureDataFolder() {
  const dataDir = join(process.cwd(), "data");
  try {
    // If `stat` succeeds, folder likely exists
    await stat(dataDir);
  } catch {
    // Otherwise, create it
    await mkdir(dataDir, { recursive: true });
  }
}

/**
 * A tiny sleep helper
 */
function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// Start the script
main().catch((err) => {
  console.error("FATAL ERROR in poll:", err);
  process.exit(1);
});
