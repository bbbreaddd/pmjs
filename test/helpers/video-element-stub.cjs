'use strict';

function GenericElement() { this._attributes = Object.create(null); }
GenericElement.prototype.getAttribute = function(name) {
  return Object.hasOwn(this._attributes, name) ? this._attributes[name] : null;
};
GenericElement.prototype.hasAttribute = function(name) { return this.getAttribute(name) !== null; };
module.exports = { GenericElement };
