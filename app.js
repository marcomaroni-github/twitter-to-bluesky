const FS = require("fs");
const HTTPS = require("follow-redirects").https;
const URI = require("urijs");

const sConfig = FS.readFileSync("config.json");
const CONFIG = JSON.parse(sConfig);

async function CreateRecord(bearerToken, tweet) {
  let options = {
    method: "POST",
    hostname: "bsky.social",
    path: "/xrpc/com.atproto.repo.createRecord",
    headers: {
      Authorization: "Bearer " + bearerToken,
      "Content-Type": "application/json",
    },
    maxRedirects: 20,
  };

  const reqCreateRecord = HTTPS.request(options, (res) => {
    let chunks = [];

    res.on("data", (chunk) => {
      chunks.push(chunk);
    });

    res.on("end", (chunk) => {
      let body = Buffer.concat(chunks);
      const recordData = JSON.parse(body.toString());
      const i = recordData.uri.lastIndexOf("/");
      if (i > 0) {
        const rkey = recordData.uri.substring(i + 1);
        const postUri = `https://bsky.app/profile/${CONFIG.bskyAccount}/post/${rkey}`;
        console.log("  Blusky post create, URI: " + postUri);
      } else {
        console.log(recordData);
      }
    });

    res.on("error", (error) => {
      console.error(error);
    });
  });

  let facets = [];
  { // links
    URI.withinString(tweet.full_text, (url, start, end) => {
      facets.push({
        index: {
          byteStart: start,
          byteEnd: end,
        },
        features: [
          {
            $type: "app.bsky.richtext.facet#link",
            uri: url,
          },
        ],
      });

      return url;
    });
  }

  { // hashtag
    const re = /(?:^|\s)(#[^\d\s]\S*)(?=\s)?/g;
    while ((match = re.exec(tweet.full_text))) {
      let [tag] = match;
      const hasLeadingSpace = /^\s/.test(tag);

      tag = tag.trim().replace(/\p{P}+$/gu, ""); // strip ending punctuation

      // inclusive of #, max of 64 chars
      if (tag.length > 66) continue;

      const index = match.index + (hasLeadingSpace ? 1 : 0);

      facets.push({
        index: {
          byteStart: index,
          byteEnd: index + tag.length, // inclusive of last char
        },
        features: [
          {
            $type: "app.bsky.richtext.facet#tag",
            tag: tag.replace(/^#/, ""),
          },
        ],
      });
    }
  }

  let postData = JSON.stringify({
    repo: CONFIG.bskyAccount,
    collection: "app.bsky.feed.post",
    record: {
      text: tweet.full_text,
      facets: facets,
      createdAt: new Date(tweet.created_at).toISOString(),
    },
  });

  reqCreateRecord.write(postData);

  reqCreateRecord.end();
}

function GetSession(identifier, password) {
  let options = {
    method: "POST",
    hostname: "bsky.social",
    path: "/xrpc/com.atproto.server.createSession",
    headers: {
      "Content-Type": "application/json",
    },
    maxRedirects: 20,
  };

  var req = HTTPS.request(options, function (res) {
    var chunks = [];

    res.on("data", function (chunk) {
      chunks.push(chunk);
    });

    res.on("end", function (chunk) {
      var body = Buffer.concat(chunks);
      // console.log(body.toString());
      sessionData = JSON.parse(body.toString());
      if (sessionData?.accessJwt != null) {
        const bearerToken = sessionData?.accessJwt;
        console.log("ACCESS_JWT:" + bearerToken);

        const fTweets = FS.readFileSync(CONFIG.tweetsFile);
        const tweets = JSON.parse(fTweets);
        if (tweets != null && tweets.length > 0) {
          const sortedTweets = tweets.sort((a, b) => {
            ad = new Date(a.tweet.created_at).getTime();
            bd = new Date(b.tweet.created_at).getTime();
            return ad - bd;
          });

          // const first = sortedTweets[0].tweet;
          // const last = sortedTweets[sortedTweets.length-1].tweet

          for (let index = 0; index < sortedTweets.length; index++) {
            const tweet = sortedTweets[index].tweet;

            if (tweet.id != "1586630236405469189") continue;

            console.log(`Parse tweet id '${tweet.id}'`);
            console.log(` Created at ${new Date(tweet.created_at).toISOString()}`);
            console.log(` Full text '${tweet.full_text}'`);
            URI.withinString(tweet.full_text, (url) => {
              console.log(` Inner URL '${url}'`);
            });

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

            CreateRecord(bearerToken, tweet);

            if (index > 1) break;
          }
        }
      }
    });

    res.on("error", function (error) {
      console.error(error);
    });
  });

  var postData = JSON.stringify({
    identifier,
    password,
  });

  req.write(postData);

  req.end();
}

GetSession(CONFIG.bskyAccount, CONFIG.bskyPwd);
