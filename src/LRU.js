

class LRUItem{

	constructor(node){
		this.previous = undefined;
		this.next = undefined;
		this.node = node;
	}

	dispose() {
		this.previous = undefined;
		this.next = undefined;
		this.node = undefined;
	}
}

/**
 *
 * @class A doubly-linked-list of the least recently used elements.
 */
class LRU{

	constructor(){
		// the least recently used item
		this.first = undefined;
		// the most recently used item
		this.last = undefined;
		// a list of all items in the lru list
		this.items = {};
		this.elements = 0;
		this.numPoints = 0;
	}

	size(){
		return this.elements;
	}

	contains(node){
		return !!this.items[node.id];
	}

	touch(node){
		if (!node.loaded) {
			return;
		}

		let item;
		if (!this.items[node.id]) {
			// add to list
			item = new LRUItem(node);
			item.previous = this.last;
			this.last = item;
			if (item.previous) {
				item.previous.next = item;
			}

			this.items[node.id] = item;
			this.elements++;

			if (!this.first) {
				this.first = item;
			}
			this.numPoints += node.numPoints;
		} else {
			// update in list
			item = this.items[node.id];
			//item = item || {};
			if (!item.previous) {
				// handle touch on first element
				if (item.next) {
					this.first = item.next;
					this.first.previous = undefined;
					item.previous = this.last;
					item.next = undefined;
					this.last = item;
					item.previous.next = item;
				}
			} else if (!item.next) {
				// handle touch on last element
			} else {
				// handle touch on any other element
				item.previous.next = item.next;
				item.next.previous = item.previous;
				item.previous = this.last;
				item.next = undefined;
				this.last = item;
				item.previous.next = item;
			}
		}
	}

	remove(node){
		let lruItem = this.items[node.id];
		if (lruItem) {
			if (this.elements === 1) {
				this.first = undefined;
				this.last = undefined;
			} else {
				if (!lruItem.previous) {
					this.first = lruItem.next;
					this.first.previous = undefined;
				}
				if (!lruItem.next) {
					this.last = lruItem.previous;
					this.last.next = undefined;
				}
				if (lruItem.previous && lruItem.next) {
					lruItem.previous.next = lruItem.next;
					lruItem.next.previous = lruItem.previous;
				}
			}

			delete this.items[node.id];
			this.elements--;
			this.numPoints -= node.numPoints;
		}
	}

	getLRUItem(){
		if (!this.first) {
			return undefined;
		}
		let lru = this.first;

		return lru.node;
	}

	toString(){
		let string = '{ ';
		let curr = this.first;
		while (curr) {
			string += curr.node.id;
			if (curr.next) {
				string += ', ';
			}
			curr = curr.next;
		}
		string += '}';
		string += '(' + this.size() + ')';
		return string;
	}

	freeMemory(){
		if (this.elements <= 1) {
			return;
		}

		while (this.numPoints > Potree.pointLoadLimit) {
			let element = this.first;
			let node = element.node;
			this.disposeDescendants(node);
		}
	}

	dispose() {
		//console.log('LRU.dispose');
		if (this.first) {
			this.first.dispose();
			this.first = undefined;
		}
		if (this.last) {
			this.last.dispose();
			this.last = undefined;
		}
		this.items = {};
		this.elements = 0;
		this.numPoints = 0;
	}

	disposeDescendants(node){
		let stack = [];
		stack.push(node);
		while (stack.length > 0) {
			let current = stack.pop();

			// console.log(current);

			current.dispose();
			this.remove(current);

			for (let key in current.children) {
				if (current.children.hasOwnProperty(key)) {
					let child = current.children[key];
					if (child.loaded) {
						stack.push(current.children[key]);
					}
				}
			}
		}
	}

}

//export {LRU, LRUItem};
export {LRU};