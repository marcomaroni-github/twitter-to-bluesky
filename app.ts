import * as dotenv from 'dotenv';
import { https } from 'follow-redirects';
import FS from 'fs';
import he from 'he';
import * as process from 'process';
import URI from 'urijs';

import { AppBskyEmbedVideo, AppBskyVideoDefs, AtpAgent, BlobRef, RichText } from '@atproto/api';

dotenv.config();

const agent = new AtpAgent({
    service: 'https://bsky.social',
})

const SIMULATE = process.env.SIMULATE === "1";

const API_DELAY = 2500; // https://docs.bsky.app/docs/advanced-guides/rate-limits

const PAST_HANDLES = process.env.PAST_HANDLES?.split(",");

let MIN_DATE: Date | undefined = undefined;
if (process.env.MIN_DATE != null && process.env.MIN_DATE.length > 0)
    MIN_DATE = new Date(process.env.MIN_DATE as string);

let MAX_DATE: Date | undefined = undefined;
if (process.env.MAX_DATE != null && process.env.MAX_DATE.length > 0)
    MAX_DATE = new Date(process.env.MAX_DATE as string);

function isNotEmpty(obj: object) {
    for (const prop in obj) {
        if (Object.hasOwn(obj, prop)) {
            return true;
        }
    }
    return false;
}

async function resolveShorURL(url: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        https.get(url, response => {
            resolve(response.responseUrl);
        }).on('error', err => {
            console.warn(`Error parsing url ${url}`);
            resolve(url);
        });
    });
}

async function cleanTweetText(tweetFullText: string): Promise<string> {
    let newText = tweetFullText;
    const urls: string[] = [];
    URI.withinString(tweetFullText, (url, start, end, source) => {
        urls.push(url);
        return url;
    });

    if (urls.length > 0) {
        const newUrls: string[] = [];
        for (let index = 0; index < urls.length; index++) {
            const newUrl = await resolveShorURL(urls[index]);
            newUrls.push(newUrl);
        }

        if (newUrls.length > 0) {
            let j = 0;
            newText = URI.withinString(tweetFullText, (url, start, end, source) => {
                // I exclude links to photos and videos, because they have already been inserted into the Bluesky post independently
                if ((PAST_HANDLES || []).some(handle => newUrls[j].startsWith(`https://x.com/${handle}/`))
                    && (newUrls[j].indexOf("/photo/") > 0 || newUrls[j].indexOf("/video/") > 0)) {
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

async function main() {
    console.log(`Import started at ${new Date().toISOString()}`)
    console.log(`SIMULATE is ${SIMULATE ? "ON" : "OFF"}`);

    const fTweets = FS.readFileSync(process.env.ARCHIVE_FOLDER + "/data/tweets.js");

    const tweets = JSON.parse(fTweets.toString().replace("window.YTD.tweets.part0 = [", "["));
    let importedTweet = 0;
    if (tweets != null && tweets.length > 0) {
        const sortedTweets = tweets.sort((a, b) => {
            let ad = new Date(a.tweet.created_at).getTime();
            let bd = new Date(b.tweet.created_at).getTime();
            return ad - bd;
        });

        await agent.login({ identifier: process.env.BLUESKY_USERNAME!, password: process.env.BLUESKY_PASSWORD! })

        for (let index = 0; index < sortedTweets.length; index++) {
            const tweet = sortedTweets[index].tweet;
            const tweetDate = new Date(tweet.created_at);
            const tweet_createdAt = tweetDate.toISOString();

            //this checks assume that the array is sorted by date (first the oldest)
            if (MIN_DATE != undefined && tweetDate < MIN_DATE)
                continue;
            if (MAX_DATE != undefined && tweetDate > MAX_DATE)
                break;

            // if (tweet.id != "1237000612639846402")
            //     continue;

            console.log(`Parse tweet id '${tweet.id}'`);
            console.log(` Created at ${tweet_createdAt}`);
            console.log(` Full text '${tweet.full_text}'`);

            if (tweet.in_reply_to_screen_name) {
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
            let embeddedVideo = [] as any;
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
                            videoFilePath = `${baseVideoPath}${videoFileName.substring(0, tailIndex)}`
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
                            uploadUrl.searchParams.append("name", videoFilePath.split("/").pop()!);
    
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
                                console.warn(`${jobStatus.error}. Video will be posted as a link`);
                                continue;
                            }
                            
                            console.log(" JobId:", jobStatus.jobId);
                            if (jobStatus.error) {
                                console.warn(`${jobStatus.error}. Video will be posted as link`);
                                continue;
                            }
    
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

                            embeddedVideo = {
                                $type: "app.bsky.embed.video",
                                video: blob,
                            } satisfies AppBskyEmbedVideo.Main;
                        }
                    }
                }
            }

            let postText = tweet.full_text as string;
            if (!SIMULATE) {
                postText = await cleanTweetText(tweet.full_text);

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
                embed: embeddedImage.length > 0 ? { $type: "app.bsky.embed.images", images: embeddedImage } :
                    isNotEmpty(embeddedVideo) ? embeddedVideo : undefined
            }

            if (!SIMULATE) {
                //I wait 3 seconds so as not to exceed the api rate limits
                await new Promise(resolve => setTimeout(resolve, API_DELAY));

                const recordData = await agent.post(postRecord);
                const i = recordData.uri.lastIndexOf("/");
                if (i > 0) {
                    const rkey = recordData.uri.substring(i + 1);
                    const postUri = `https://bsky.app/profile/${process.env.BLUESKY_USERNAME!}/post/${rkey}`;
                    console.log("Bluesky post create, URL: " + postUri);

                    importedTweet++;
                } else {
                    console.warn(recordData);
                }
            } else {
                importedTweet++;
            }
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
