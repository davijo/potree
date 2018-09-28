
export class WorkerPool {
	constructor() {
		this.workers = {};
	}

	getWorker(url) {
		if (!this.workers[url]) {
			this.workers[url] = [];
		}

		if (this.workers[url].length === 0) {
			let worker = new Worker(url);
			this.workers[url].push(worker);
		}

		let worker = this.workers[url].pop();

		return worker;
	}

	returnWorker(url, worker) {
		this.workers[url].push(worker);
	}

	dispose() {
		let keys = [];
		for (let key in this.workers) {
			if (!this.workers.hasOwnProperty(key)) {
				continue;
			}
			keys.push(key);
		}

		for (let key of keys) {
			for (let worker of this.workers[key]) {
				worker.terminate();
				worker = undefined;
			}
		}

		this.workers = {};
	}
};

//Potree.workerPool = new Potree.WorkerPool();

export default new WorkerPool();