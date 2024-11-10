import * as dotenv from 'dotenv';
import { http, https } from 'follow-redirects';
import FS from 'fs';
import he from 'he';
import path from 'path';
import process, { title } from 'process';
import URI from 'urijs';
import sharp from 'sharp';

import { AppBskyVideoDefs, AtpAgent, BlobRef, RichText } from '@atproto/api';

import { getEmbeddedUrlAndRecord, getMergeEmbed, getReplyRefs } from './libs/bskyParams';
import { checkPastHandles, convertToBskyPostUrl, getBskyPostUrl } from './libs/urlHandler';
let fetch: any;
(async () => {
    fetch = (await import('node-fetch')).default;
})();
import { load } from 'cheerio'
const oembetter = require('oembetter')();
oembetter.endpoints(oembetter.suggestedEndpoints);

dotenv.config();

const agent = new AtpAgent({
    service: 'https://bsky.social',
})

const SIMULATE = process.env.SIMULATE === "1";
const API_DELAY = 2500; // https://docs.bsky.app/docs/advanced-guides/rate-limits
const TWEETS_MAPPING_FILE_NAME = 'tweets_mapping.json'; // store the imported tweets & bsky id mapping
const DISABLE_IMPORT_REPLY = process.env.DISABLE_IMPORT_REPLY === "1";
const MAX_FILE_SIZE = 1 * 1024 * 1024; // 1MB


let MIN_DATE: Date | undefined = undefined;
if (process.env.MIN_DATE != null && process.env.MIN_DATE.length > 0)
    MIN_DATE = new Date(process.env.MIN_DATE as string);

let MAX_DATE: Date | undefined = undefined;
if (process.env.MAX_DATE != null && process.env.MAX_DATE.length > 0)
    MAX_DATE = new Date(process.env.MAX_DATE as string);

let alreadySavedCache = false;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3';

async function resolveShorURL(url: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        try{
            if (url.startsWith('https://')) {
                https.get(url, {
                    headers: {
                        'User-Agent': USER_AGENT
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
                        'User-Agent': USER_AGENT
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

            if (   checkPastHandles(newUrl) 
                && newUrl.indexOf("/photo/") == -1 
                && newUrl.indexOf("/video/") == -1 
                && embeddedUrl != newUrl) {
              // self quote exchange ( tweet-> bsky)
              newUrls.push(convertToBskyPostUrl(newUrl, tweets))
            }else{
              newUrls.push(newUrl)
            }

        }

        if (newUrls.length > 0) {
            let j = 0;
            newText = URI.withinString(tweetFullText, (url, start, end, source) => {
                // I exclude links to photos, because they have already been inserted into the Bluesky post independently
                // also exclude embeddedUrl (ex. your twitter quote post)
                if ( (checkPastHandles(newUrls[j]) && (newUrls[j].indexOf("/photo/") > 0 || newUrls[j].indexOf("/video/") > 0) )
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

function getTweets(){
    // get cache (from last time imported)
    let caches = []
    if(FS.existsSync(TWEETS_MAPPING_FILE_NAME)){
        caches = JSON.parse(FS.readFileSync(TWEETS_MAPPING_FILE_NAME).toString());
    }

    // get original tweets
    const fTweets = FS.readFileSync(process.env.ARCHIVE_FOLDER + "/data/tweets.js");
    let tweets = JSON.parse(cleanTweetFileContent(fTweets));

    let archiveExists = true;
    for (let i=1; archiveExists; i++) {
        let archiveFile = `${process.env.ARCHIVE_FOLDER}/data/tweets-part${i}.js`;
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
                const imgBuffer = await imgResp.buffer();

                const blobRecord = await agent.uploadBlob(imgBuffer, {
                    encoding: imgResp.headers.get('content-type') || 'image/jpeg'
                });

                card.thumb = {
                    $type: "blob",
                    ref: blobRecord.data.blob.ref,
                    mimeType: blobRecord.data.blob.mimeType,
                    size: blobRecord.data.blob.size
                };
            }
        }
        else {
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
                const imgBuffer = await imgResp.buffer();

                const blobRecord = await agent.uploadBlob(imgBuffer, {
                    encoding: imgResp.headers.get('content-type') || 'image/jpeg'
                });

                card.thumb = {
                    $type: "blob",
                    ref: blobRecord.data.blob.ref,
                    mimeType: blobRecord.data.blob.mimeType,
                    size: blobRecord.data.blob.size
                };
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



async function recompressImageIfNeeded(filePath: string): Promise<Buffer> {
    let quality = 70; // Start at 70% quality
    let image = sharp(filePath);
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
        buffer = await sharp(filePath).jpeg(options).toBuffer();
    }

    if (buffer.length > MAX_FILE_SIZE) {
        console.warn(`Could not reduce image size below 1MB for file: ${filePath}`);
    }

    return buffer;
}

async function main() {
    console.log(`Import started at ${new Date().toISOString()}`)
    console.log(`SIMULATE is ${SIMULATE ? "ON" : "OFF"}`);
    console.log(`IMPORT REPLY is ${!DISABLE_IMPORT_REPLY ? "ON" : "OFF"}`);

    const tweets = getTweets();
  
    let importedTweet = 0;
    if (tweets != null && tweets.length > 0) {
        const sortedTweets = tweets.sort((a, b) => {
            let ad = new Date(a.tweet.created_at).getTime();
            let bd = new Date(b.tweet.created_at).getTime();
            return ad - bd;
        });

        await agent.login({ identifier: process.env.BLUESKY_USERNAME!, password: process.env.BLUESKY_PASSWORD! });
       
        process.on('exit', () => saveCache(sortedTweets));
        process.on('SIGINT', () => process.exit());

        try{
            for (let index = 0; index < sortedTweets.length; index++) {
                const currentData =  sortedTweets[index];
                const { tweet, bsky } = currentData;
                const tweetDate = new Date(tweet.created_at);
                const tweet_createdAt = tweetDate.toISOString();

                //this cheks assume that the array is sorted by date (first the oldest)
                if (MIN_DATE != undefined && tweetDate < MIN_DATE)
                    continue;
                if (MAX_DATE != undefined && tweetDate > MAX_DATE)
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

                if (DISABLE_IMPORT_REPLY && tweet.in_reply_to_screen_name) {
                    console.log("Discarded (reply)");
                    continue;
                }
                if (tweet.full_text.startsWith("@")) {
                    console.log("Discarded (start with @)");
                    continue;
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
                                    break;
                            }
                            if (mimeType.length <= 0)
                                continue;

                            if (index > 3) {
                                console.warn("Bluesky does not support more than 4 images per post, excess images will be discarded.")
                                break;
                            }

                            let mediaFilename = `${process.env.ARCHIVE_FOLDER}${path.sep}data${path.sep}tweets_media${path.sep}${tweet.id}-${media?.media_url.substring(i + 1)}`;

                            let localMediaFileNotFound = true;
                            if (FS.existsSync(mediaFilename)) {
                                localMediaFileNotFound = false
                            }

                            if (localMediaFileNotFound) {
                                const wildcardPath = `${process.env.ARCHIVE_FOLDER}${path.sep}data${path.sep}tweets_media${path.sep}${tweet.id}-*`;
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

                            if (!SIMULATE) {
                                const blobRecord = await agent.uploadBlob(imageBuffer, {
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

                            const baseVideoPath = `${process.env.ARCHIVE_FOLDER}/data/tweets_media/${tweet.id}-`;
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
    
                            if (!SIMULATE) {
                                const { data: serviceAuth } = await agent.com.atproto.server.getServiceAuth(
                                    {
                                      aud: `did:web:${agent.dispatchUrl.host}`,
                                      lxm: "com.atproto.repo.uploadBlob",
                                      exp: Date.now() / 1000 + 60 * 30, // 30 minutes
                                    },
                                  );
        
                                const token = serviceAuth.token;
        
                                const videoBuffer = FS.readFileSync(videoFilePath);
                                
                                const uploadUrl = new URL(
                                    "https://video.bsky.app/xrpc/app.bsky.video.uploadVideo",
                                  );
                                uploadUrl.searchParams.append("did", agent.session!.did);
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
                const { embeddedUrl = null, embeddedRecord = null } = getEmbeddedUrlAndRecord(tweet.entities?.urls, sortedTweets);

                let replyTo: {}|null = null; 
                if ( !DISABLE_IMPORT_REPLY && !SIMULATE && tweet.in_reply_to_screen_name) {
                    replyTo = getReplyRefs(tweet,sortedTweets);
                }

                let postText = tweet.full_text as string;
                if (!SIMULATE) {
                    postText = await cleanTweetText(tweet.full_text, tweet.entities?.urls, embeddedUrl, sortedTweets);

                    if (postText.length > 300)
                        postText = tweet.full_text;

                    if (postText.length > 300)
                        postText = postText.substring(0, 296) + '...';

                    if (tweet.full_text != postText)
                        console.log(` Clean text '${postText}'`);
                }
               
                let externalEmbed = null;
                if (tweet.entities?.urls) {
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

                if (!SIMULATE) {
                    //I wait 3 seconds so as not to exceed the api rate limits
                    await new Promise(resolve => setTimeout(resolve, API_DELAY));

                    const recordData = await agent.post(postRecord);
                    const i = recordData.uri.lastIndexOf("/");
                    if (i > 0) {
                        const postUri = getBskyPostUrl(recordData.uri);
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

    if (SIMULATE) {
        // In addition to the delay in AT Proto API calls, we will also consider a 5% delta for URL resolution calls
        const minutes = Math.round((importedTweet * API_DELAY / 1000) / 60) + (1 / 0.1);
        const hours = Math.floor(minutes / 60);
        const min = minutes % 60;
        console.log(`Estimated time for real import: ${hours} hours and ${min} minutes`);
    }
    
    console.log(`Import finished at ${new Date().toISOString()}, imported ${importedTweet} tweets`)

}

main();
