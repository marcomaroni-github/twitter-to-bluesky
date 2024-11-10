import * as dotenv from 'dotenv';
import { http, https } from 'follow-redirects';
import FS from 'fs';
import he from 'he';
import process from 'process';
import URI from 'urijs';

import { AppBskyEmbedVideo, AppBskyVideoDefs, AtpAgent, BlobRef, RichText } from '@atproto/api';

import { getEmbeddedUrlAndRecord, getMergeEmbed, getReplyRefs } from './libs/bskyParams';
import { checkPastHandles, convertToBskyPostUrl, getBskyPostUrl } from './libs/urlHandler';

dotenv.config();

const agent = new AtpAgent({
    service: 'https://bsky.social',
})

const SIMULATE = process.env.SIMULATE === "1";

const API_DELAY = 2500; // https://docs.bsky.app/docs/advanced-guides/rate-limits

const TWEETS_MAPPING_FILE_NAME = 'tweets_mapping.json'; // store the imported tweets & bsky id mapping

const DISABLE_IMPORT_REPLY = process.env.DISABLE_IMPORT_REPLY === "1";


let MIN_DATE: Date | undefined = undefined;
if (process.env.MIN_DATE != null && process.env.MIN_DATE.length > 0)
    MIN_DATE = new Date(process.env.MIN_DATE as string);

let MAX_DATE: Date | undefined = undefined;
if (process.env.MAX_DATE != null && process.env.MAX_DATE.length > 0)
    MAX_DATE = new Date(process.env.MAX_DATE as string);

let alreadySavedCache = false;

async function resolveShorURL(url: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        if (url.startsWith('https://')) {
            https.get(url, response => {
                resolve(response.responseUrl);
            }).on('error', err => {
                console.warn(`Error parsing url ${url}`);
                resolve(url);
            });
        } else if (url.startsWith('http://')) {
            http.get(url, response => {
                resolve(response.responseUrl);
            }).on('error', err => {
                console.warn(`Error parsing url ${url}`);
                resolve(url);
            });
        } else {
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
            const newUrl = urlMappings.find(({url}) => urls[index] == url )?.expanded_url ?? await resolveShorURL(urls[index]);

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

                            const mediaFilename = `${process.env.ARCHIVE_FOLDER}/data/tweets_media/${tweet.id}-${media?.media_url.substring(i + 1)}`;

                            let localMediaFileNotFound = true;
                            if (FS.existsSync(mediaFilename)) {
                                localMediaFileNotFound = false
                                break;
                            }
    
                            if (!localMediaFileNotFound) {
                                console.warn(`Local media file not found into archive, tweet discarded. Local path: ${mediaFilename}`);
                                continue
                            }
                            
                            const imageBuffer = FS.readFileSync(mediaFilename);

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
                                })
                            }
                        }

                        if (media?.type === "video") {
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
                                console.warn(`Local video file not found into archive, tweet discarded. Local path: ${videoFilePath}`);
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
                                    continue;
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
