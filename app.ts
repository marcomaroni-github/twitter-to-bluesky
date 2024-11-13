import { load } from 'cheerio';
import * as dotenv from 'dotenv';
import { http, https } from 'follow-redirects';
import FS from 'fs';
import he from 'he';
import path from 'path';
import process, { title } from 'process';
import sharp from 'sharp';
import URI from 'urijs';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { AppBskyVideoDefs, AtpAgent, BlobRef, RichText } from '@atproto/api';

import { getEmbeddedUrlAndRecord, getMergeEmbed, getReplyRefs } from './libs/bskyParams';
import { checkPastHandles, convertToBskyPostUrl, getBskyPostUrl } from './libs/urlHandler';

let fetch: any;
(async () => {
    fetch = (await import('node-fetch')).default;
})();
const oembetter = require('oembetter')();
oembetter.endpoints(oembetter.suggestedEndpoints);

const TWEETS_MAPPING_FILE_NAME = 'tweets_mapping.json'; // store the imported tweets & bsky id mapping
const MAX_FILE_SIZE = 1 * 1000 * 1000; // 1MiB
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3';

dotenv.config();

const agent = new AtpAgent({
    service: 'https://bsky.social',
})

let alreadySavedCache = false;

class RateLimitedAgent {
    private agent: AtpAgent;
    private waitingForRateLimit: boolean = false;

    constructor(agent: AtpAgent) {
        this.agent = agent;
    }

    private async handleRateLimit(error: any): Promise<void> {
        if (error.status === 429) {
            this.waitingForRateLimit = true;
            const resetTime = new Date(Number(error.headers['ratelimit-reset']) * 1000);
            const waitTime = resetTime.getTime() - Date.now();
            console.log(`Rate limit exceeded. Waiting until ${resetTime.toLocaleString()} (${Math.ceil(waitTime / 1000)} seconds)`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            this.waitingForRateLimit = false;
        } else {
            throw error;
        }
    }

    async call<T>(method: () => Promise<T>): Promise<T> {
        let attempts = 0;
        while (true) {
            try {
                if (this.waitingForRateLimit) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    continue;
                }
                return await method();
            } catch (error: any) {
                if ( ++attempts > 5) {
                    throw error;
                }
                if (error.message.includes('fetch failed')) {
                    console.warn(`Fetch failed, retrying attempt ${attempts}/5...`);
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    continue;
                }
                if (error.status === 429) {
                    await this.handleRateLimit(error);
                } else {
                    throw error;
                }
            }
        }
    }

    async uploadBlob(...args: Parameters<typeof AtpAgent.prototype.uploadBlob>) {
        return this.call(() => this.agent.uploadBlob(...args));
    }

    async post(...args: Parameters<typeof AtpAgent.prototype.post>) {
        return this.call(() => this.agent.post(...args));
    }

    async login(...args: Parameters<typeof AtpAgent.prototype.login>) {
        return this.call(() => this.agent.login(...args));
    }

    async getServiceAuth(...args: Parameters<typeof AtpAgent.prototype.com.atproto.server.getServiceAuth>) {
        return this.call(() => this.agent.com.atproto.server.getServiceAuth(...args));
    }

    get session() {
        return this.agent.session;
    }

    get dispatchUrl() {
        return this.agent.dispatchUrl;
    }
}

const rateLimitedAgent = new RateLimitedAgent(agent);

async function resolveShorURL(url: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        try{
            if (url.startsWith('https://')) {
                https.get(url, {
                    headers: {
                        'User-Agent': USER_AGENT,
                        'Accept-Encoding': 'gzip, deflate, br',
                        'Connection': 'keep-alive'
                    }
                }, response => {
                    resolve(response.responseUrl);
                }).on('error', err => {
                    console.warn(`Error parsing url ${url}`);
                    resolve(url);
                });
            } else if (url.startsWith('http://')) {
                http.get(url, {
                    headers: {
                        'User-Agent': USER_AGENT,
                        'Accept-Encoding': 'gzip, deflate, br',
                        'Connection': 'keep-alive'
                    }
                }, response => {
                    resolve(response.responseUrl);
                }).on('error', err => {
                    console.warn(`Error parsing url ${url}`);
                    resolve(url);
                });
            } else {
                resolve(url);
            }
        } catch($e) {
            console.warn(`Error parsing url ${url}`);
            resolve(url);
        }
    });
}

async function cleanTweetText(
    twitterHandles: string[],
    blueskyUsername: string,
    tweetFullText: string, 
    urlMappings: Array<{
        url: string;
        expanded_url: string
    }>, 
    embeddedUrl: string|null,
    tweets
): Promise<string> {
    let newText = tweetFullText;
    const urls: string[] = [];
    URI.withinString(tweetFullText, (url, start, end, source) => {
        urls.push(url);
        return url;
    });

    if (urls.length > 0) {
        const newUrls: string[] = [];
        for (let index = 0; index < urls.length; index++) {
            // use tweet.entities.urls mapping instead, so we can make sure the result is the same as the origin. 
            const newUrl = await Promise.race([
                new Promise<string>((resolve, reject) => {
                    setTimeout(() => reject(new Error('Timeout')), 5000);
                }),
                urlMappings.find(({url}) => urls[index] == url )?.expanded_url ?? resolveShorURL(urls[index])
            ]).catch(err => {
                console.warn(`Error resolving URL: ${urls[index]}  ${err.message}`);
                return urls[index];
            });

            if (   checkPastHandles(twitterHandles, newUrl) 
                && newUrl.indexOf("/photo/") == -1 
                && newUrl.indexOf("/video/") == -1 
                && embeddedUrl != newUrl) {
              // self quote exchange ( tweet-> bsky)
              newUrls.push(convertToBskyPostUrl(blueskyUsername, newUrl, tweets))
            }else{
              newUrls.push(newUrl)
            }

        }

        if (newUrls.length > 0) {
            let j = 0;
            newText = URI.withinString(tweetFullText, (url, start, end, source) => {
                // I exclude links to photos, because they have already been inserted into the Bluesky post independently
                // also exclude embeddedUrl (ex. your twitter quote post)
                if ( (checkPastHandles(twitterHandles, newUrls[j]) && (newUrls[j].indexOf("/photo/") > 0 || newUrls[j].indexOf("/video/") > 0) )
                  || embeddedUrl == newUrls[j]
                ) {
                    j++;
                    return "";
                }
                else
                    return newUrls[j++];
            });
        }
    }

    newText = he.decode(newText);

    return newText;
}

function cleanTweetFileContent(fileContent) {
    return fileContent
        .toString()
        .replace(/window\.YTD\.tweets\.part[0-9]+ = \[/, "[")
        .replace(/;$/, "");
}

function getTweets(archiveFolder: string){
    // get cache (from last time imported)
    let caches = []
    if(FS.existsSync(TWEETS_MAPPING_FILE_NAME)){
        caches = JSON.parse(FS.readFileSync(TWEETS_MAPPING_FILE_NAME).toString());
    }

    // get original tweets
    const fTweets = FS.readFileSync(path.join(archiveFolder, 'data', 'tweets.js'));
    let tweets = JSON.parse(cleanTweetFileContent(fTweets));

    let archiveExists = true;
    for (let i=1; archiveExists; i++) {
        let archiveFile = path.join(archiveFolder, 'data', `tweets-part${i}.js`);
        archiveExists = FS.existsSync(archiveFile)
        if( archiveExists ) {
            let fTweetsPart = FS.readFileSync(archiveFile);
            tweets = tweets.concat(JSON.parse(cleanTweetFileContent(fTweetsPart)));
        }
    }  

    // merge alreadyImported into tweets
    const alreadyImported = caches.filter(({ bsky })=> bsky);
    alreadyImported.forEach(({tweet: { id }, bsky })=> {
        const importedTweetIndex = tweets.findIndex(({ tweet }) => id == tweet.id );
        if( importedTweetIndex > -1 ){
            tweets[importedTweetIndex].bsky = bsky;
        }
    })

    return tweets;
}

function saveCache(sortedTweets) {
    if (alreadySavedCache) {
        return;
    }

    alreadySavedCache = true;
    console.log('Saving already imported tweets to', TWEETS_MAPPING_FILE_NAME);
    FS.writeFileSync(TWEETS_MAPPING_FILE_NAME, JSON.stringify(sortedTweets, null, 4));
}

async function fetchEmbedUrlCard(url: string): Promise<any> {
    let card = {
        uri: url,
        title: "",
        description: "",
        thumb: { $type: "none", ref: "", mimeType: "", size: 0 },
    };

    try {
        let oembedResult:any = null;
        try
        {
            oembedResult = await new Promise((resolve, reject) => {
                oembetter.fetch(url, 
                    { headers: { 'User-Agent': USER_AGENT } },
                    (err, response) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(response);
                        }
                    });
            });
        } catch (error: any) {
            console.debug(`Error fetching oembed: ${error.message}`);
        }

        if (oembedResult) {
            card.title = oembedResult.title || card.title;
            card.description = oembedResult.description || card.description;
            if (oembedResult.thumbnail_url) {
                const imgResp = await fetch(oembedResult.thumbnail_url);
                if (imgResp.ok) {
                    let imgBuffer = await imgResp.arrayBuffer();
                    let mimeType = imgResp.headers.get('content-type') || 'image/jpeg';

                    if (imgBuffer.byteLength > MAX_FILE_SIZE) {
                        imgBuffer = await recompressImageIfNeeded(imgBuffer);
                    }

                    if ( mimeType.startsWith('image/') && !mimeType.startsWith('image/svg') ) {
                        const blobRecord = await rateLimitedAgent.uploadBlob(imgBuffer, {
                            encoding: mimeType
                        });

                        card.thumb = {
                            $type: "blob",
                            ref: blobRecord.data.blob.ref,
                            mimeType: blobRecord.data.blob.mimeType,
                            size: blobRecord.data.blob.size
                        };
                    }
                }
            }
        }
        
        if (card.title.length == 0 && card.description.length == 0 && card.thumb.size == 0)
        {
            const resp = await fetch(url, {
                headers: {
                'User-Agent': USER_AGENT,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                },
                redirect: 'follow'
            });
            if (!resp.ok) {
                if ( resp.status == 401 && url.startsWith('http:') ) {
                    console.warn(`HTTP error: ${resp.status} ${resp.statusText} (try with https)`);
                    return await fetchEmbedUrlCard(url.replace('http:', 'https:'));
                }
                throw new Error(`HTTP error: ${resp.status} ${resp.statusText}`);
            }
            const html = await resp.text();
            const $ = load(html);

            const titleTag = $('meta[property="og:title"]').attr('content');
            if (titleTag) {
                card.title = he.decode(titleTag);
            }

            const descriptionTag = $('meta[property="og:description"]').attr('content');
            if (descriptionTag) {
                card.description = he.decode(descriptionTag);
            }

            const imageTag = $('meta[property="og:image"]').attr('content');
            if (imageTag) {
                let imgUrl = imageTag;
                if (!imgUrl.includes('://')) {
                    imgUrl = new URL(imgUrl, url).href;
                }

                const imgResp = await fetch(imgUrl);
                if (imgResp.ok) {
                    let imgBuffer = await imgResp.arrayBuffer();
                    let mimeType = imgResp.headers.get('content-type') || 'image/jpeg';

                    if (imgBuffer.byteLength > MAX_FILE_SIZE) {
                        imgBuffer = await recompressImageIfNeeded(imgBuffer);
                        mimeType = 'image/jpeg';
                    }

                    if ( mimeType.startsWith('image/') && !mimeType.startsWith('image/svg')) {
                        const blobRecord = await rateLimitedAgent.uploadBlob(imgBuffer, {
                            encoding: mimeType
                        });

                        card.thumb = {
                            $type: "blob",
                            ref: blobRecord.data.blob.ref,
                            mimeType: blobRecord.data.blob.mimeType,
                            size: blobRecord.data.blob.size
                        };
                    }
                }
            }
        }
    } catch (error: any) {
        console.warn(`Error fetching embed URL card: ${error.message}`);
        return null;
    }

    if (card.thumb.size == 0 && (card.title.length > 0 || card.description.length > 0)) {
        return {
            $type: "app.bsky.embed.external",
            external: {
                uri: url,
                title: card.title,
                description: card.description,
            }
        };
    } else if ((card.title.length == 0 && card.description.length == 0)) {
        return null;
    }

    return {
        $type: "app.bsky.embed.external",
        external: card,
    };
}

async function recompressImageIfNeeded(imageData: string|ArrayBuffer): Promise<Buffer> {
    let quality = 90; // Start at 90% quality
    let image = sharp(imageData);
    const metadata = await image.metadata();

    // Convert non-JPEG images to JPEG format initially
    if (metadata.format !== 'jpeg') {
        image = image.toFormat('jpeg');
    }

    let options : sharp.JpegOptions = { quality: quality };
    let buffer = await image.jpeg(options).toBuffer();

    // Recompression loop if the buffer size is still above 1MB
    while (buffer.length > MAX_FILE_SIZE && quality > 10) {
        quality -= 10; // Step down quality by 10%
        options = { quality: quality };
        buffer = await sharp(imageData).jpeg(options).toBuffer();
    }

    if (buffer.length > MAX_FILE_SIZE) {
        console.warn(`Could not reduce image size below 1MB for file: ${imageData}`);
    }

    return buffer;
}

async function main() {

    const argv = yargs(hideBin(process.argv))
        .option('simulate', {
            type: 'boolean',
            description: 'Simulate the import without making any changes (defaults to false)',
            default: process.env.SIMULATE === '1',
        })
        .option('disable-import-reply', {
            type: 'boolean',
            description: 'Disable importing replies',
            default: process.env.DISABLE_IMPORT_REPLY === '1',
        })
        .option('min-date', {
            type: 'string',
            description: 'Minimum date for tweets to import (YYYY-MM-DD)',
            default: process.env.MIN_DATE,
        })
        .option('max-date', {
            type: 'string',
            description: 'Maximum date for tweets to import (YYYY-MM-DD)',
            default: process.env.MAX_DATE,
        })
        .option('api-delay', {
            type: 'number',
            description: 'Delay between API calls in milliseconds',
            default: process.env.API_DELAY ? parseInt(process.env.API_DELAY) : 2500,
        })
        .option('archive-folder', {
            type: 'string',
            description: 'Path to the archive folder',
            default: process.env.ARCHIVE_FOLDER,
            demandOption: true,
        })
        .option('bluesky-username', {
            type: 'string',
            description: 'Bluesky username',
            default: process.env.BLUESKY_USERNAME,
            demandOption: true,
        })
        .option('bluesky-password', {
            type: 'string',
            description: 'Bluesky password',
            default: process.env.BLUESKY_PASSWORD,
            demandOption: true,
        })
        .option('twitter-handles', {
            type: 'array',
            description: 'Twitter handles to import',
            default: process.env.TWITTER_HANDLES?.split(','),
            demandOption: true,
        })
        .help()
        .argv;

    let minDate = argv.minDate ? new Date(argv.minDate) : undefined;
    let maxDate = argv.maxDate ? new Date(argv.maxDate) : undefined;

    console.log(`Import started at ${new Date().toISOString()}`)
    console.log(`Simulate is ${argv.simulate ? "ON" : "OFF"}`);
    console.log(`Import Reply is ${!argv.disableImportReply ? "ON" : "OFF"}`);
    console.log(`Min Date is ${minDate ? minDate.toISOString() : "OFF"}`);
    console.log(`Max Date is ${maxDate ? maxDate.toISOString() : "OFF"}`);
    console.log(`API Delay is ${argv.apiDelay}ms`);
    console.log(`Archive Folder is ${argv.archiveFolder}`);
    console.log(`Bluesky Username is ${argv.blueskyUsername}`);

    const tweets = getTweets(argv.archiveFolder);
  
    let importedTweet = 0;
    if (tweets != null && tweets.length > 0) {
        const sortedTweets = tweets.sort((a, b) => {
            let ad = new Date(a.tweet.created_at).getTime();
            let bd = new Date(b.tweet.created_at).getTime();
            return ad - bd;
        });

        await rateLimitedAgent.login({ identifier: argv.blueskyUsername, password: argv.blueskyPassword });
       
        process.on('exit', () => saveCache(sortedTweets));
        process.on('SIGINT', () => process.exit());

        try{
            for (let index = 0; index < sortedTweets.length; index++) {
                const currentData =  sortedTweets[index];
                const { tweet, bsky } = currentData;
                const tweetDate = new Date(tweet.created_at);
                const tweet_createdAt = tweetDate.toISOString();

                //this cheks assume that the array is sorted by date (first the oldest)
                if (minDate != undefined && tweetDate < minDate)
                    continue;
                if (maxDate != undefined && tweetDate > maxDate)
                    break;
                
                if(bsky){
                    // already imported
                    continue;
                }
                // if (tweet.id != "1237000612639846402")
                //     continue;

                console.log(`Parse tweet id '${tweet.id}'`);
                console.log(` Created at ${tweet_createdAt}`);
                console.log(` Full text '${tweet.full_text}'`);

                if (argv.disableImportReply && tweet.in_reply_to_screen_name) {
                    console.log("Discarded (reply)");
                    continue;
                }

                if (tweet.in_reply_to_screen_name) {
                    if (argv.twitterHandles.some(handle => tweet.in_reply_to_screen_name == handle)) {
                        // Remove "@screen_name" from the beginning of the tweet's full text
                        const replyPrefix = `@${tweet.in_reply_to_screen_name} `;
                        if (tweet.full_text.startsWith(replyPrefix)) {
                            tweet.full_text = tweet.full_text.replace(replyPrefix, '').trim();
                        }
                    } else {
                        console.log("Discarded (reply to another user)");
                        continue;
                    }
                }

                if (tweet.full_text.startsWith("RT ")) {
                    console.log("Discarded (start with RT)");
                    continue;
                }

                let embeddedImage = [] as any;
                let embeddedVideo: BlobRef | undefined = undefined;
                if (tweet.extended_entities?.media) {

                    for (let index = 0; index < tweet.extended_entities.media.length; index++) {
                        const media = tweet.extended_entities.media[index];

                        if (media?.type === "photo") {

                            if (tweet.full_text.includes(media?.url)) {
                                tweet.full_text = tweet.full_text.replace(media?.url, '').replace(/\s\s+/g, ' ').trim();
                            }

                            const i = media?.media_url.lastIndexOf("/");
                            const it = media?.media_url.lastIndexOf(".");
                            const fileType = media?.media_url.substring(it + 1)
                            let mimeType = "";
                                                        
                            switch (fileType) {
                                case "png":
                                    mimeType = "image/png"
                                    break;
                                case "jpg":
                                    mimeType = "image/jpeg"
                                    break;
                                default:
                                    console.error("Unsupported photo file type" + fileType);
                                    continue;
                            }
                            if (mimeType.length <= 0)
                                continue;

                            if (index > 3) {
                                console.warn("Bluesky does not support more than 4 images per post, excess images will be discarded.")
                                break;
                            }

                            let mediaFilename = `${argv.archiveFolder}${path.sep}data${path.sep}tweets_media${path.sep}${tweet.id}-${media?.media_url.substring(i + 1)}`;

                            let localMediaFileNotFound = true;
                            if (FS.existsSync(mediaFilename)) {
                                localMediaFileNotFound = false
                            }

                            if (localMediaFileNotFound) {
                                const wildcardPath = `${argv.archiveFolder}${path.sep}data${path.sep}tweets_media${path.sep}${tweet.id}-*`;
                                const files = FS.readdirSync(path.dirname(wildcardPath)).filter(file => file.startsWith(`${tweet.id}-`));

                                if (files.length > 0) {
                                    mediaFilename = path.join(path.dirname(wildcardPath), files[0]);
                                    localMediaFileNotFound = false;
                                }
                            }
    
                            if (localMediaFileNotFound) {
                                console.warn(`Local media file not found into archive. Local path: ${mediaFilename}`);
                                continue
                            }
                        
                            let imageBuffer = FS.readFileSync(mediaFilename);

                            // Check if the image size exceeds 1MB or if it’s a non-JPEG format
                            if (mimeType === 'image/png' || mimeType === 'image/webp' || mimeType === 'image/jpeg' && imageBuffer.length > MAX_FILE_SIZE) {
                                imageBuffer = await recompressImageIfNeeded(mediaFilename);
                                mimeType = 'image/jpeg';
                            }

                            if (!argv.simulate) {
                                const blobRecord = await rateLimitedAgent.uploadBlob(imageBuffer, {
                                    encoding: mimeType
                                });

                                embeddedImage.push({
                                    alt: "",
                                    image: {
                                        $type: "blob",
                                        ref: blobRecord.data.blob.ref,
                                        mimeType: blobRecord.data.blob.mimeType,
                                        size: blobRecord.data.blob.size
                                    }
                                });
                            }
                        }

                        if (media?.type === "video") {

                            if (tweet.full_text.includes(media?.url)) {
                                tweet.full_text = tweet.full_text.replace(media?.url, '').replace(/\s\s+/g, ' ').trim();
                            }

                            const baseVideoPath = `${argv.archiveFolder}/data/tweets_media/${tweet.id}-`;
                            let videoFileName = '';
                            let videoFilePath = '';
                            let localVideoFileNotFound = true;
                            for(let v=0; v<media?.video_info?.variants?.length; v++) {
                                videoFileName = media.video_info.variants[v].url.split("/").pop()!;
                                const tailIndex = videoFileName.indexOf("?");
                                if( tailIndex>0 )
                                    videoFileName = videoFileName.substring(0, tailIndex);
                                videoFilePath = `${baseVideoPath}${videoFileName}`;
                                if (FS.existsSync(videoFilePath)) {
                                    localVideoFileNotFound = false
                                    break;
                                }
                            }
    
                            if (localVideoFileNotFound) {
                                console.warn(`Local video file not found into archive. Local path: ${videoFilePath}`);
                                continue
                            }
    
                            if (!argv.simulate) {
                                const { data: serviceAuth } = await rateLimitedAgent.getServiceAuth(
                                    {
                                      aud: `did:web:${rateLimitedAgent.dispatchUrl.host}`,
                                      lxm: "com.atproto.repo.uploadBlob",
                                      exp: Date.now() / 1000 + 60 * 30, // 30 minutes
                                    },
                                  );
        
                                const token = serviceAuth.token;
        
                                const videoBuffer = FS.readFileSync(videoFilePath);
                                
                                const uploadUrl = new URL(
                                    "https://video.bsky.app/xrpc/app.bsky.video.uploadVideo",
                                  );
                                uploadUrl.searchParams.append("did", rateLimitedAgent.session!.did);
                                uploadUrl.searchParams.append("name", videoFilePath.split("/").pop()!+"1");
        
                                console.log(" Upload video");
    
                                const uploadResponse = await fetch(uploadUrl, {
                                    method: "POST",
                                    headers: {
                                        Authorization: `Bearer ${token}`,
                                        "Content-Type": "video/mp4",
                                        "Content-Length": String(videoBuffer.length),
                                    },
                                    body: videoBuffer,
                                });
                                
                                const jobStatus = (await uploadResponse.json()) as AppBskyVideoDefs.JobStatus;
                                if (jobStatus.error) {
                                    console.warn(` Video job status: '${jobStatus.error}'. Video will be posted as a link`);
                                }
                                console.log(" JobId:", jobStatus.jobId);
        
                                let blob: BlobRef | undefined = jobStatus.blob;
        
                                const videoAgent = new AtpAgent({ service: "https://video.bsky.app" });
                                
                                while (!blob) {
                                  const { data: status } = await videoAgent.app.bsky.video.getJobStatus(
                                    { jobId: jobStatus.jobId },
                                  );
                                  console.log("  Status:",
                                    status.jobStatus.state,
                                    status.jobStatus.progress || "",
                                  );
                                  if (status.jobStatus.blob) {
                                    blob = status.jobStatus.blob;
                                  }
                                  // wait a second
                                  await new Promise((resolve) => setTimeout(resolve, 1000));
                                }
    
                                embeddedVideo = blob;
                            }
                        }
                    }
                }

                // handle bsky embed record
                const { embeddedUrl = null, embeddedRecord = null } = getEmbeddedUrlAndRecord(argv.twitterHandles, tweet.entities?.urls, sortedTweets);

                let replyTo: {}|null = null; 
                if ( !argv.disableImportReply && !argv.simulate && tweet.in_reply_to_screen_name) {
                    replyTo = getReplyRefs(argv.twitterHandles, tweet, sortedTweets);
                }

                let postText = tweet.full_text as string;
                if (!argv.simulate) {
                    postText = await cleanTweetText(argv.twitterHandles, argv.blueskyUsername, tweet.full_text, tweet.entities?.urls, embeddedUrl, sortedTweets);

                    if (postText.length > 300)
                        postText = tweet.full_text;

                    if (postText.length > 300)
                        postText = postText.substring(0, 296) + '...';

                    if (tweet.full_text != postText)
                        console.log(` Clean text '${postText}'`);
                }
               
                let externalEmbed = null;
                if (tweet.entities?.urls && !argv.simulate) {
                    for (const urlEntity of tweet.entities.urls) {
                        if (!urlEntity.expanded_url.startsWith('https://twitter.com') && !urlEntity.expanded_url.startsWith('https://x.com')) {
                            try {
                                externalEmbed = await fetchEmbedUrlCard(urlEntity.expanded_url);
                            }
                            catch (error: any) {
                                console.warn(`Error fetching embed URL card: ${error.message}`);
                            }
                        }
                    }
                }

                const rt = new RichText({
                    text: postText
                });
                await rt.detectFacets(agent);
                // Remove mentions without a did
                if (rt.facets) {
                    rt.facets = rt.facets.filter(facet => {
                        if (facet.features) {
                            facet.features = facet.features.filter(feature => {
                                if (feature.$type === 'app.bsky.richtext.facet#mention' && !feature.did) {
                                    return false;
                                }
                                return true;
                            });
                        }
                        return facet.features.length > 0;
                    });
                }
                const postRecord = {
                    $type: 'app.bsky.feed.post',
                    text: rt.text,
                    facets: rt.facets,
                    createdAt: tweet_createdAt,
                }

                const embed = getMergeEmbed(embeddedImage, embeddedVideo, embeddedRecord);
                if(embed && Object.keys(embed).length > 0){
                    Object.assign(postRecord, { embed });
                } else if (externalEmbed) {
                    Object.assign(postRecord, { embed: externalEmbed });
                }

                if(replyTo && Object.keys(replyTo).length > 0){
                    Object.assign(postRecord, { reply: replyTo });
                }

                console.log(postRecord);

                if (!argv.simulate) {
                    //I wait 3 seconds so as not to exceed the api rate limits
                    await new Promise(resolve => setTimeout(resolve, argv.apiDelay));

                    try 
                    {
                        const recordData = await rateLimitedAgent.post(postRecord);
                        const i = recordData.uri.lastIndexOf("/");
                        if (i > 0) {
                            const postUri = getBskyPostUrl(argv.blueskyUsername, recordData.uri);
                            console.log("Bluesky post create, URL: " + postUri);

                            importedTweet++;
                        } else {
                            console.warn(recordData);
                        }

                        // store bsky data into sortedTweets (then write into the mapping file)
                        currentData.bsky = {
                            uri: recordData.uri,
                            cid: recordData.cid,
                        };
                    }
                    catch (error: any) {
                        console.warn(`Error posting tweet: ${postRecord} ${error.message}`);
                    }
                    
                } else {
                    importedTweet++;
                }
            }
        }catch($e){
            throw $e;
        }finally {
            // always update the mapping file
            saveCache(sortedTweets);
        }
    }

    if (argv.simulate) {
        // In addition to the delay in AT Proto API calls, we will also consider a 5% delta for URL resolution calls
        const minutes = Math.round((importedTweet * argv.apiDelay / 1000) / 60) + (1 / 0.1);
        const hours = Math.floor(minutes / 60);
        const min = minutes % 60;
        console.log(`Estimated time for real import: ${hours} hours and ${min} minutes`);
    }
    
    console.log(`Import finished at ${new Date().toISOString()}, imported ${importedTweet} tweets`)

}

main();
