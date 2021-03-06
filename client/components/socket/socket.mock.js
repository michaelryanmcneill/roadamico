'use strict';

angular.module('socketMock', [])
  .factory('socket', function() {
    return {
      socket: {
        connect: function() {},
        on: function() {},
        emit: function() {},
        receive: function() {}
      },

      reconnect: function () {},
      syncUpdates: function() {},
      unsyncUpdates: function() {}
    };
  });
