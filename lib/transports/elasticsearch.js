var request = require('request');

var elasticsearch = function (parent, baseUrl) {
    if(baseUrl.substr(-1) == '/') {
        baseUrl = baseUrl.substr(0, baseUrl.length - 1);
    }
    this.baseUrl            = baseUrl;
    this.parent             = parent;
    this.lastScrollId       = null;
    this.totalSearchResults = 0;
};

// accept callback
// return (error, arr) where arr is an array of objects
elasticsearch.prototype.get = function(limit, offset, callback){
    var self = this;
    var type = self.parent.options.type;
    if(type === 'data'){
        self.getData(limit, offset, callback);
    }else if(type === 'mapping'){
        self.getMapping(limit, offset, callback);
    }else{
        callback(new Error('unknown type option'), null);
    }
}

elasticsearch.prototype.getMapping = function (limit, offset, callback){
    var self = this;
    if(self.gotMapping === true){
        callback(null, [])
    }else{
        var url = self.baseUrl + '/_mapping';
        request.get(url, function(err, response){
            self.gotMapping = true;
            var payload = [];
            if(err == null){ response = payload.push(response.body); }
            callback(err, payload);
        });
    }
}

elasticsearch.prototype.getData = function (limit, offset, callback){
    var searchBody, searchRequest, self, uri;
    self = this;

    if (offset >= self.totalSearchResults && self.totalSearchResults != 0) {
        callback(null, []);
        return;
    }

    if (self.lastScrollId !== null) {
        scrollResultSet(self, callback);
    } else {
        elasticsearch.prototype.numberOfShards(self.baseUrl ,function(err, numberOfShards){
            var shardedLimit = Math.ceil(limit / numberOfShards);

            uri = self.baseUrl +
                  "/" +
                  "_search?search_type=scan&scroll=" +
                  self.parent.options.scrollTime +
                  "&size=" + shardedLimit;

            searchBody = {
                "query": {
                    "match_all": {}
                },
                "size": shardedLimit
            };

            searchRequest = {
                "uri": uri,
                "method": "GET",
                "body": JSON.stringify(searchBody)
            };

            request.get(searchRequest, function requestResonse (err, response) {
                if(err != null){
                    callback(err, []);
                    return;
                }else if(response.statusCode != 200){
                    err = new Error(response.body);
                    callback(err, []);
                    return;
                }

                var body = JSON.parse(response.body);
                self.lastScrollId = body._scroll_id;
                self.totalSearchResults = body.hits.total;

                scrollResultSet(self, callback);
            });
        });
    }
};

// to respect the --limit param, we need to set the scan/sroll limit = limit/#Shards
// http://www.elasticsearch.org/guide/en/elasticsearch/guide/current/scan-scroll.html
elasticsearch.prototype.numberOfShards = function(baseUrl, callback){
    request.get(baseUrl + "/_settings", function(err, response){
        if(err != null){
            callback(err)
        }else{
            try{
                body = JSON.parse(response.body);
                var indexParts = baseUrl.split('/');
                var index = indexParts[(indexParts.length - 1)];    
                var numberOfShards = body[index].settings.index.number_of_shards;
                callback(err, numberOfShards);
            }catch(e){
                callback(err, 1);
            }
        }
    });
}

// accept arr, callback where arr is an array of objects
// return (error, writes)
elasticsearch.prototype.set = function(data, limit, offset, callback){
    var self = this;
    var type = self.parent.options.type;
    if(type === 'data'){
        self.setData(data, limit, offset, callback);
    }else if(type === 'mapping'){
        self.setMapping(data, limit, offset, callback);
    }else{
        callback(new Error('unknown type option'), null);
    }
}

elasticsearch.prototype.setMapping = function(data, limit, offset, callback){
    var self           = this;
    if(self.haveSetMapping === true){
        callback(null, 0);
    }else{
        data = JSON.parse(data[0]);
        var started = 0;
        var count   = 0;
        for(index in data){
            var mappings = data[index]['mappings'];
            for(key in mappings){
                var mapping  =  {};
                mapping[key] = {'properties': mappings[key]['properties']};
                var url = self.baseUrl + '/' + key + '/_mapping'; 
                started++;
                count++;
                request.put(self.baseUrl, function(err, response){ // ensure the index exists
                    var payload = {
                        url: url,
                        body: JSON.stringify(mapping),
                    };
                    request.put(payload, function(err, response){ // upload the mapping
                        started--;
                        if(err == null){
                            var bodyError = JSON.parse(response.body).error;
                            if(bodyError != null){ err = bodyError; }
                        }
                        if(started == 0){
                            self.haveSetMapping = true;
                            callback(err, count);
                        }
                    });
                });
            }
        }
    }
}

elasticsearch.prototype.setData = function(data, limit, offset, callback){
    var self = this;
    var error = null;
    var writes = 0;
    if (self.parent.options.bulk === true){
        var thisUrl = self.baseUrl + "/_bulk";
        var payload = {
            url:  thisUrl,
            body: "",
        };
        data.forEach(function(elem, index, theArray) {
            var val = "{ \"index\" : { ";
            val += "\"_index\" : \"" + elem._index + "\", ";
            val += "\"_type\" : \""  + elem._type  + "\", ";
            val += "\"_id\" : \""    + elem._id    + "\"";
            val += " } }\n";
            val += JSON.stringify(elem._source) + "\n";
            theArray[index] = val;
        });
        payload.body = data.join("");
        request.put(payload, function(err, response, body){
            var writes = 0;
            try{
                var r = JSON.parse(response.body);
                if(r.items != null){
                    if(r.ok === true ){
                        writes = data.length;
                    }else{
                        r.items.forEach(function(item){
                            if(item.index.status < 400){
                                writes++;
                            }
                        });
                    }
                }
            }catch(e){
                err = e;
            }
            self.reindex(function(err){
                callback(err, writes)
            });
        });
    }else{
        var started = 0;
        data.forEach(function(elem){
            started++;
            var thisUrl = self.baseUrl + "/";
            if(self.parent.options.all === true){ thisUrl += elem._index + "/"; }
            thisUrl += elem._type + "/" + elem._id;
            var payload = {
                url:  thisUrl,
                body: JSON.stringify(elem._source)
            };
            self.parent.emit('debug', 'thisUrl: ' + thisUrl + ", elem._source: " + JSON.stringify(elem._source));

            request.put(payload, function(err, response, body){
                if(err != null){ error = err }
                try{
                    var r = JSON.parse(response.body);
                    if(r.ok == true || r._version >= 1){ writes++; }
                }catch(e){ }
                started--;
                if(started === 0){
                    self.reindex(function(err){
                        callback(error, writes)
                    });
                }
            });
        });

        if(data.length === 0){
            process.nextTick(function(){
                callback(error, writes);
            });
        }
    }
}


elasticsearch.prototype.del = function(elem, callback){
    var self = this;
    var thisUrl = self.baseUrl + "/" + encodeURIComponent(elem._type) + "/" + encodeURIComponent(elem._id);

    self.parent.emit('debug', 'deleteUrl: ' + thisUrl);
    request.del(thisUrl, function(err, response, body){
        if(typeof callback == 'function'){ callback(err, response, body); }
    });
};

elasticsearch.prototype.reindex = function(callback){
    var self = this;
    request.post(self.baseUrl + "/_refresh", function(err, response){
        callback(err, response);
    });
};

exports.elasticsearch = elasticsearch;

/////////////
// HELPERS //
/////////////

/**
 * Posts requests to the _search api to fetch the latest
 * scan result with scroll id
 * @param that
 * @param callback
 */
function scrollResultSet(that, callback) {
    var self = that;
    var baseUrl = self.baseUrl;
    var searchUrl;
    
    if (baseUrl.split('/').length -1 <= 2) {
        searchUrl = baseUrl;
    } else {
        searchUrl = baseUrl.substr(0, baseUrl.lastIndexOf('/'));
    }
    

    scrollRequest = {
        "uri": searchUrl + "/" + "_search" + "/scroll?scroll=" + self.parent.options.scrollTime,
        "method": "POST",
        "body": self.lastScrollId
    };

    request.get(scrollRequest, function requestResonse (err, response) {
        if(response.statusCode != 200 && err == null){
            err = new Error(response.body);
            callback(err, []);
            return;
        }

        var body = JSON.parse(response.body);
        self.lastScrollId = body._scroll_id;
        var hits = body.hits.hits;

        if(self.parent.options.delete === true && hits.length > 0) {
            var stated = 0;
            hits.forEach(function(elem){
                stated++;
                self.del(elem, function(){
                    stated--;
                    if(stated === 0){
                        self.reindex(function(err){
                            if (hits.length === 0) {
                                self.lastScrollId = null;
                            }
                            callback(err, hits);
                        });
                    }
                });
            });
        } else {
            if (hits.length === 0) {
                self.lastScrollId = null;
            }
            callback(err, hits);
        }
    });
}
