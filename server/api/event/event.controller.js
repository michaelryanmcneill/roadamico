'use strict';

var _ = require('lodash');
var Event = require('./event.model');
var Notification = require('../notification/notification.model');
var moment = require('moment');


// Can view if admin, not restricted, or member of restriction group
var canView = _.curry(function (user, event) {
  var a = !(event.groupRestriction && event.groupRestriction.length);
  if (!user) {
    return a;
  }
  var b = user.role === 'admin' || user.role === 'curator';
  var c = !!_.find(event.groupRestriction, function (group) {
    return (group.administrator && group.administrator.equals(user._id)) || !!_.find(user.groups, function (groupId) {
        return group._id.equals(groupId);
      });
  });
  return a || b || c;
});

// Can edit if admin, creator, or leader of restriction group
var canEdit = _.curry(function (user, event) {
  var a = user.role === 'admin' || user.role === 'curator';
  var b = event.creator.equals(user._id);
  var c = !!_.find(event.groupRestriction, function (group) {
    return group.administrator && group.administrator.equals(user._id);
  });
  return a || b || c;
});


// Get list of visible events
exports.all = function (req, res) {
  Event.find({})
    .populate('groupRestriction', 'administrator')
    .exec(function (err, events) {
      if (err) {
        return handleError(res, err);
      }
      events = _.filter(events, canView(req.user));
      return res.json(200, events);
    });
};

// Get list of events by place id
exports.index = function (req, res) {
  Event.find({place: req.params.id})
    .populate('groupRestriction', 'administrator')
    .exec(function (err, events) {
      if (err) {
        return handleError(res, err);
      }
      events = _.filter(events, canView(req.user));
      return res.json(200, events);
    });
};

// Get a single event
exports.show = function (req, res) {
  Event.findById(req.params.id)
    .populate('participants.participant', 'name')
    .populate('messages.poster', 'name')
    .populate('groupRestriction', 'administrator name')
    .exec(function (err, event) {
      if (err) {
        return handleError(res, err);
      }
      if (!event) {
        return res.send(404);
      }
      if (!canView(req.user)) {
        return res.send(403);
      }
      return res.json(event);
    });
};

// Creates a new event in the DB.
exports.create = function (req, res) {
  // Creator can't define participants or messages
  delete req.body.participants;
  delete req.body.messages;
  if (!req.body.place) {
    return res.json(403, {message: 'An event must have an associated place.'});
  }
  req.body.created = moment().toISOString();
  req.body.creator = req.user._id;
  req.body.participants = [{participant: req.user._id, datetime: moment().toISOString()}];
  Event.create(req.body, function (err, event) {
    if (err) {
      return handleError(res, err);
    }
    return res.json(201, event);
  });
};

// Updates an existing event in the DB.
exports.update = function (req, res) {
  delete req.body._id;
  delete req.body.participants; // Can't change this
  delete req.body.messages;     // Or this
  Event.findById(req.params.id)
    .populate('groupRestriction', 'administrator')
    .exec(function (err, event) {
      if (err) {
        return handleError(res, err);
      }
      if (!event) {
        return res.send(404);
      }
      if (!canEdit(req.user)) {
        return res.json(403, {message: 'You are not authorized to modify this event'});
      }

      event.name = req.body.name || event.name;
      event.datetime = req.body.datetime || event.datetime;
      event.meetupTime = req.body.meetupTime || event.meetupTime;
      event.meetupPlace = req.body.meetupPlace || event.meetupPlace;
      event.groupRestriction = req.body.groupRestriction || event.groupRestriction;

      event.save(function (err, event) {
        if (err) {
          return handleError(res, err);
        }
        var populateOpts = [
          {path: 'participants.participant', select: 'name'},
          {path: 'messages.poster', select: 'name'},
          {path: 'groupRestriction', select: 'administrator name'}
        ];
        event.populate(populateOpts, function (err, event) {
          if (err) {
            return handleError(res, err);
          }
          return res.json(event);
        });
      });
    });
};

// Cancels the event
exports.cancel = function (req, res) {
  Event.findById(req.params.id)
    .populate('groupRestriction', 'administrator')
    .exec(function (err, event) {
      if (err) {
        return handleError(res, err);
      }
      if (!event) {
        return res.send(404);
      }
      if (!canEdit(req.user)) {
        return res.json(403, {message: 'You are not authorized to modify this event'});
      }

      event.canceled = true;
      event.save(function (err, event) {
        if (err) {
          return handleError(res, err);
        }

        // Notify the participants that the event was canceled
        var notifications = _(event.participants).pluck('participant')
          .map(function (id) {  // Build the notification from the user's id
            return {
              user: id,
              datetime: moment().toISOString(),
              data: {
                name: 'event.cancel',
                event: event,
                when: moment(event.datetime).format('llll')
              }
            };
          }).value();
        Notification.create(notifications);

        return res.json(event);
      });
    });
};

// Joins the user as a participant to an event
exports.join = function (req, res) {
  Event.findById(req.params.id)
    .populate('groupRestriction', 'administrator')
    .exec(function (err, event) {
      if (err) {
        return handleError(res, err);
      }
      if (!event) {
        return res.send(404);
      }
      if (!canView(req.user)) {
        return res.send(403);
      }

      if (_.find(event.participants, function (p) {
          return req.user._id.equals(p.participant);
        })) {
        return res.json(403, {message: 'You have already joined this event.'});
      }

      event.participants.push({
        datetime: moment().toISOString(),
        participant: req.user._id
      });
      event.save(function (err, event) {
        if (err) {
          return handleError(res, err);
        }

        var populateOpts = [
          {path: 'participants.participant', select: 'name'},
          {path: 'messages.poster', select: 'name'}
        ];
        event.populate(populateOpts, function (err, event) {
          if (err) {
            return handleError(res, err);
          }
          return res.json(event);
        });
      });
    });
};

// user backs out of event
exports.unjoin = function (req, res) {
  Event.findById(req.params.id, function (err, event) {
    if (err) {
      return handleError(res, err);
    }
    if (!event) {
      return res.send(404);
    }

    var pIdx = _.findIndex(event.participants, function (p) {
      return req.user._id.equals(p.participant);
    });
    if (pIdx === -1) {
      return res.json(403, {message: 'You have not joined this event.'});
    }
    event.participants.splice(pIdx, 1);

    event.save(function (err, event) {
      if (err) {
        return handleError(res, err);
      }

      var populateOpts = [
        {path: 'participants.participant', select: 'name'},
        {path: 'messages.poster', select: 'name'}
      ];
      event.populate(populateOpts, function (err, event) {
        if (err) {
          return handleError(res, err);
        }
        return res.json(event);
      });
    });
  });
};

exports.message = function (req, res) {
  Event.findById(req.params.id, function (err, event) {
    if (err) {
      return handleError(res, err);
    }
    if (!event) {
      return res.send(404);
    }

    // Must be a participant to message
    if (!_.find(event.participants, function (p) {
        return req.user._id.equals(p.participant);
      })) {
      return res.json(403, {message: 'You must be attending this event to send messages.'});
    }

    req.body.datetime = moment().toISOString();
    req.body.poster = req.user._id;
    event.messages.push(req.body);
    event.save(function (err, event) {
      if (err) {
        return handleError(res, err);
      }

      // Notify the participants of the message
      var notifications = _(event.participants).pluck('participant')
        .filter(function (id) { // Don't message the user creating the message
          return !req.user._id.equals(id);
        }).map(function (id) {  // Build the notification from the user's id
          return {
            user: id,
            datetime: moment().toISOString(),
            data: {
              name: 'event.message',
              text: req.body.text,
              event: event,
              poster: req.user
            }
          };
        }).value();
      Notification.create(notifications);

      var populateOpts = [
        {path: 'participants.participant', select: 'name'},
        {path: 'messages.poster', select: 'name'}
      ];
      event.populate(populateOpts, function (err, event) {
        if (err) {
          return handleError(res, err);
        }
        return res.json(event);
      });
    });
  });
};

function handleError(res, err) {
  return res.send(500, err);
}
