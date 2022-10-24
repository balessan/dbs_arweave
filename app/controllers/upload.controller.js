const Bundlr = require("@bundlr-network/client");

const axios = require('axios');
const Upload = require("../models/upload.model.js");
const Quote = require("../models/quote.model.js");
const Nonce = require("../models/nonce.model.js");
const ethers = require('ethers');
const { acceptToken } = require("./tokens.js");
const { QUOTE_STATUS_PAYMENT_FAILED } = require("../models/quote.model.js");

exports.upload = async (req, res) => {
	console.log(`upload endpoint called: ${JSON.stringify(req.body)}`)

	// Validate request
	if(!req.body) {
		res.status(400).send({
			message: "Content can not be empty!"
		});
		return;
	}

	// validate fields
	const quoteId = req.body.quoteId;
	if(typeof quoteId === "undefined") {
		res.status(400).send({
			message: "Missing quoteId."
		});
		return;
	}
	if(typeof quoteId !== "string") {
		res.status(400).send({
			message: "Invalid quoteId."
		});
		return;
	}

	const files = req.body.files;
	if(typeof files === "undefined") {
		res.status(400).send({
			message: "Missing files field."
		});
		return;
	}
	if(typeof files !== "object" || !Array.isArray(files)) {
		res.status(400).send({
			message: "Invalid files field."
		});
		return;
	}
	if(files.length == 0) {
		res.status(400).send({
			message: "Empty files field."
		});
		return;
	}

	if(files.length > 64) {
		res.status(400).send({
			message: "Too many files. Max 64."
		});
		return;
	}

	const cidRegex = /^(Qm[1-9A-HJ-NP-Za-km-z]{44,}|b[A-Za-z2-7]{58,}|B[A-Z2-7]{58,}|z[1-9A-HJ-NP-Za-km-z]{48,}|F[0-9A-F]{50,})$/i;
	for(let i = 0; i < files.length; i++) {
		if(typeof files[i] !== "string") {
			res.status(400).send({
				message: `Invalid files field on index ${i}.`
			});
			return;
		}
		// TODO: validate URL format better
		if(!files[i].startsWith('ipfs://')) {
			res.status(400).send({
				message: `Invalid files URI on index ${i}. Must be ipfs://<CID>`
			});
			return;
		}
		if(!cidRegex.test(files[i].substring(7))) {
			res.status(400).send({
				message: `Invalid files URI on index ${i}. Must be ipfs://<CID>`
			});
			return;
		}
	}

	const nonce = req.body.nonce;
	if(typeof nonce === "undefined") {
		res.status(400).send({
			message: "Missing nonce."
		});
		return;
	}
	if(typeof nonce !== "number") {
		res.status(400).send({
			message: "Invalid nonce."
		});
		return;
	}

	const signature = req.body.signature;
	if(typeof signature === "undefined") {
		res.status(400).send({
			message: "Missing signature."
		});
		return;
	}
	if(typeof signature !== "string") {
		res.status(400).send({
			message: "Invalid signature."
		});
		return;
	}

	// validate quote
	await Quote.get(quoteId, async (err, quote) => {
		if(err) {
			if(err.code == 404) {
				res.status(404).send({
					message: "Quote not found"
				});
				return;
			}
			res.status(500).send({
				message:
					err.message || "Error occurred while validating quote."
			});
			return;
		}

		const userAddress = quote.userAddress;
		const message = ethers.utils.sha256(ethers.utils.toUtf8Bytes(quoteId + nonce.toString()));
		let signerAddress;
		try {
			signerAddress = ethers.utils.verifyMessage(message, signature);
		}
		catch(err) {
			res.status(403).send({
				message: "Invalid signature."
			});
			return;
		}

		if(signerAddress != userAddress) {
			res.status(403).send({
				message: "Invalid signature."
			});
			return;
		}

		Nonce.get(userAddress, async (err, data) => {
			if(err) {
				res.status(500).send({
					message:
						err.message || "Error occurred while validating nonce."
				});
				return;
			}
			if(data) {
				const old_nonce = data.nonce;
				if(parseFloat(nonce) <= parseFloat(old_nonce)) {
					res.status(403).send({
						message: "Invalid nonce."
					});
					return;
				}
			}
			Nonce.set(userAddress, nonce);
		});

		// see if token still accepted
		const paymentToken = acceptToken(quote.chainId, quote.tokenAddress);
		if(!paymentToken) {
			res.status(400).send({
				message: "Payment token no longer accepted."
			});
			return;
		}

		// check status of quote
		if(quote.status != Quote.QUOTE_STATUS_WAITING) {
			if(quote.status == Quote.QUOTE_STATUS_UPLOAD_END) {
				res.status(400).send({
					message: "Quote has been completed."
				});
				return;
			}
			else {
				res.status(400).send({
					message: "Quote is being processed."
				});
				return;
			}
		}

		// check if new price is sufficient
		let bundlr;
		try {
			bundlr = new Bundlr.default(process.env.BUNDLR_URI, paymentToken.bundlrName, process.env.PRIVATE_KEY, paymentToken.providerUrl ? {providerUrl: paymentToken.providerUrl, contractAddress: paymentToken.tokenAddress} : {});
		}
		catch(err) {
			res.status(500).send({
				message: err.message
			});
			return;
		}

		let priceWei;
		try {
			bundlrPriceWei = await bundlr.getPrice(quote.size)
			priceWei = ethers.BigNumber.from(bundlrPriceWei.toString());
		}
		catch(err) {
			res.status(500).send({
				message: err.message
			});
			return;
		}

		const quoteTokenAmount = ethers.BigNumber.from(quote.tokenAmount);

		if(priceWei.gte(quoteTokenAmount)) {
			res.status(402).send({
				message: `Quoted tokenAmount is less than current rate. Quoted amount: ${quote.tokenAmount}, current rate: ${priceWei.toString()}`
			});
			return;
		}

		// Create provider and wallet
		const acceptedPayments = process.env.ACCEPTED_PAYMENTS.split(",");
		const jsonRpcUris = process.env.JSON_RPC_URIS.split(",");
		const jsonRpcUri = jsonRpcUris[acceptedPayments.indexOf(paymentToken.bundlrName)];
		const tokenDetails = acceptToken(quote.chainId, quote.tokenAddress);
		let provider;
		if(jsonRpcUri === "default") {
			const defaultProviderUrl = tokenDetails.providerUrl;
			console.log(`Using "default" provider url (from tokens) = ${defaultProviderUrl}`);
			provider = ethers.getDefaultProvider(defaultProviderUrl);
		}
		else {
			console.log(`Using provider url from JSON_RPC_URIS = ${jsonRpcUri}`);
			provider = ethers.getDefaultProvider(jsonRpcUri);
		}
		console.log(`network = ${JSON.stringify(await provider.getNetwork())}`);
		const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

		// Check server gas token balance
		const nativeBalance = wallet.getBalance();

		// Create ERC20 contract handle
		const abi = [
			'function transferFrom(address from, address to, uint256 value) external returns (bool)',
			'function allowance(address owner, address spender) external view returns (uint256)',
			'function balanceOf(address owner) external view returns (uint256)',
			'function deposit(uint256 value) external',
			'function withdraw(uint256 value) external',
			'function transfer(address to, uint256 value) external returns (bool)'
		];
		const tokenAddress = tokenDetails.wrappedAddress || tokenDetails.tokenAddress ;
		const token = new ethers.Contract(tokenAddress, abi, wallet);

		// Estimate cost of:
		// 1. Pull ERC-20 token from userAddress
		const transferFromEstimate = token.estimateGas.transferFrom(userAddress, wallet.address, priceWei);
		// 2. Unwrap if necessary
		const unwrapEstimate = token.estimateGas.withdraw(priceWei);
		// 3. Push funds to Bundlr account
		// TODO: Don't hardcode Bundlr Address. Or maybe it's fine.
		const bundlrAddressOnMumbai = "0x853758425e953739F5438fd6fd0Efe04A477b039";
		const sendEthEstimate = wallet.estimateGas({to: bundlrAddressOnMumbai, value: priceWei});
		// 4. Possibly refund in case of non-recoverable failure
		const wrapEstimate = token.estimateGas.deposit(priceWei); // Assume price not dependent on amount
		const transferEstimate = token.estimateGas.transfer(userAddress, priceWei); // Assume price not dependent on amount

		let totalEstimate = transferFromEstimate + sendEthEstimate + transferEstimate;
		if(tokenDetails.wrappedAddress) {
			totalEstimate += unwrapEstimate + wrapEstimate;
		}
		console.log(totalEstimate.toString());

		// TODO: Check server gas token balance, ensure sufficient for 2 transactions:
		// If not enough for (1), throw error
		// If enough for (1) but not enough for (2)...throw error? OR request extra funds from user to cover gas costs?

		res.send(null); // send 200

		// change status
		await Quote.setStatus(quoteId, Quote.QUOTE_STATUS_PAYMENT_START);




		console.log(`payment token address = ${token.address}`);

		// Check allowance
		const allowance = await token.allowance(userAddress, wallet.address);
		console.log(`allowance = ${allowance}`);

		if(allowance.lte(priceWei)) {
			console.log(`Allowance is less than current rate. Quoted amount: ${quote.tokenAmount}, current rate: ${priceWei.toString()}, allowance: ${allowance}`);
			return;
		}

		// TODO: Set status

		// Pull payment from user's account using transferFrom(userAddress, amount)
		const confirms = tokenDetails.confirms;
		try {
			await (await token.transferFrom(userAddress, wallet.address, priceWei)).wait(confirms);
		}
		catch(err) {
			console.log(err);
			Quote.setStatus(quoteId, Quote.QUOTE_STATUS_PAYMENT_FAILED);
			return;
		}

		// TODO: Set status

		// If payment is wrapped, unwrap it (ex. WETH -> ETH)
		if(tokenDetails.wrappedAddress) {
			try {
				await (await token.withdraw(priceWei)).wait(confirms);
			}
			catch(err) {
				console.log(err);
				Quote.setStatus(quoteId, QUOTE_STATUS_PAYMENT_FAILED);
				return;
			}
		}

		// TODO: Set status

		// Fund our EOA's Bundlr Account
		// TODO: Check the balance first
		try {
			let response = await bundlr.fund(bundlrPriceWei);
			// TODO: should we record the response values?
			/* {
				id: '0x15d26881006589bd3ac5366ebd5031d8c14a2755d962337fad7216744fe92ed5',
				quantity: '3802172224166296',
				reward: '45832500525000',
				target: '0x853758425e953739F5438fd6fd0Efe04A477b039'
			} */
		}
		catch(err) {
			// can't fund the quote
			console.log("Can't fund the quote.")
			console.log(err.message);
			return;
		}

		await Quote.setStatus(quoteId, Quote.QUOTE_STATUS_PAYMENT_END);
		await Quote.setStatus(quoteId, Quote.QUOTE_STATUS_UPLOAD_START);

		let files_uploaded = 0;
		await Promise.all(files.map(async (file, index) => {
			await Upload.get(quoteId, index, async (err, quotedFile) => {
				if(err) {
					console.log(err);
					return;
				}
				// TODO: get IPFS gateway from config
				const ipfsFile = `https://cloudflare-ipfs.com/ipfs/${file.substring(7)}`;

				// download file
				await axios({
						method: "get",
						url: ipfsFile,
						responseType: "arraybuffer"
					})
					.then(response => {
						// download started
						const contentType = response.headers['content-type'];
						const httpLength = parseInt(response.headers['content-length']);

						if(httpLength) {
							if(httpLength != quotedFile.length) {
								// quoted size is different than real size
								console.log(`Different lengths, quoted length = ${quotedFile.length}, http length ${httpLength}`);
							}
						}

						let tags = [];
						if(contentType) {
							// TODO: sanitize contentType
							tags = [{name: "Content-Type", value: contentType}];
						}

						const uploader = bundlr.uploader.chunkedUploader;

						uploader.setChunkSize(524288);
						uploader.setBatchSize(1);

						uploader.on("chunkUpload", (chunkInfo) => {
							//console.log(`Uploaded Chunk number ${chunkInfo.id}, offset of ${chunkInfo.offset}, size ${chunkInfo.size} Bytes, with a total of ${chunkInfo.totalUploaded} bytes uploaded.`);
						});
						uploader.on("chunkError", (e) => {
							//console.error(`Error uploading chunk number ${e.id} - ${e.res.statusText}`);
						});
						uploader.on("done", async (finishRes) => {
							const transactionId = finishRes.data.id;
							Upload.setHash(quoteId, index, transactionId);

							// perform HEAD request to Arweave Gateway to verify that file uploaded successfully
							try {
								axios.head(`https://arweave.net/${transactionId}`);

								files_uploaded = files_uploaded + 1;
								if(files_uploaded == files.length) {
									await Quote.setStatus(quoteId, Quote.QUOTE_STATUS_UPLOAD_END);
								}

							}
							catch(err) {
								// transactionId not found
								console.log(`Unable to retreive uploaded file with transaction id ${transactionId}, error: ${err.response.status}`);
							}


						});

						const transactionOptions = {tags: tags};
						try {
							// start upload
							uploader.uploadData(Buffer.from(response.data, "binary"), transactionOptions);
							// TODO: also hash the file
						}
						catch(error) {
							console.log(error.message);
							console.log("unique message");
							// TODO: Revisit this status code and consider changing to something unique
							// TODO: Add separate status for insufficient funds, upload fail, etc.
							Quote.setStatus(quoteId, Quote.QUOTE_STATUS_PAYMENT_FAILED);
						}
					})
					.catch(error => {
						console.log(error);
					});
			});
		}));
	});
};
