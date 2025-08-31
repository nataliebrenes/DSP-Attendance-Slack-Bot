const { App } = require('@slack/bolt');

// Initialize your app with your bot token and signing secret
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN
});

// Store active meetings in memory
const activeMeetings = new Map();

// Calculate distance between two coordinates (in meters)
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // Earth's radius in meters
  const φ1 = lat1 * Math.PI/180;
  const φ2 = lat2 * Math.PI/180;
  const Δφ = (lat2-lat1) * Math.PI/180;
  const Δλ = (lon2-lon1) * Math.PI/180;

  const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
          Math.cos(φ1) * Math.cos(φ2) *
          Math.sin(Δλ/2) * Math.sin(Δλ/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

  return R * c; // Distance in meters
}

// Mock function for getting user location
// In real implementation, you'd collect this through Slack location sharing
async function getUserLocation(userId) {
  // For testing purposes, return mock coordinates
  // You can modify this to use real location data
  const mockLocations = {
    // Add real user IDs and their typical locations for testing
    // 'U1234567890': { lat: 37.7749, lng: -122.4194 }, // San Francisco
    // 'U0987654321': { lat: 37.7849, lng: -122.4094 }, // Nearby location
  };
  
  // Return mock location or default to same location (for testing)
  return mockLocations[userId] || { lat: 37.7749, lng: -122.4194 };
}

// Start meeting slash command
app.command('/start-meeting', async ({ command, ack, respond, client }) => {
  await ack();

  const meetingId = `meeting_${Date.now()}`;
  const initiatorId = command.user_id;
  const channelId = command.channel_id;
  const meetingName = command.text || 'Meeting';
  
  try {
    // Get initiator's location
    const initiatorLocation = await getUserLocation(initiatorId);
    
    // Store meeting info
    activeMeetings.set(meetingId, {
      meetingId,
      initiatorId,
      channelId,
      meetingName,
      location: initiatorLocation,
      attendees: new Map(), // Store attendee ID and check-in time
      radius: 150, // 150 meters default radius
      startTime: new Date()
    });

    // Get channel members
    const channelInfo = await client.conversations.members({
      channel: channelId
    });

    let notificationsSent = 0;

    // Check proximity for each member and send notifications
    const proximityChecks = channelInfo.members.map(async (memberId) => {
      if (memberId === initiatorId) return; // Skip initiator
      
      try {
        const memberLocation = await getUserLocation(memberId);
        const distance = calculateDistance(
          initiatorLocation.lat, 
          initiatorLocation.lng,
          memberLocation.lat, 
          memberLocation.lng
        );

        // Only send to members within radius
        if (distance <= activeMeetings.get(meetingId).radius) {
          await client.chat.postMessage({
            channel: memberId, // Send DM to user
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `📍 *${meetingName}*\n\nYou're near the meeting location! Click below to check in for attendance.`
                }
              },
              {
                type: "actions",
                elements: [
                  {
                    type: "button",
                    text: {
                      type: "plain_text",
                      text: "✅ Check In"
                    },
                    action_id: "checkin",
                    value: meetingId,
                    style: "primary"
                  }
                ]
              }
            ]
          });
          notificationsSent++;
        }
      } catch (error) {
        console.log(`Could not check proximity for user ${memberId}:`, error);
      }
    });

    await Promise.all(proximityChecks);

    // Send confirmation to initiator with control panel
    await respond({
      text: `Meeting "${meetingName}" started! Notifications sent to ${notificationsSent} nearby members.`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `✅ *Meeting Started: ${meetingName}*\n\n📍 **Location:** Set to your current position\n📡 **Radius:** 150 meters\n📨 **Notifications sent:** ${notificationsSent} nearby members\n⏰ **Started:** ${new Date().toLocaleTimeString()}\n\n*Meeting ID:* \`${meetingId}\``
          }
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "👥 View Attendance"
              },
              action_id: "view_attendance",
              value: meetingId
            },
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "🔴 End Meeting"
              },
              action_id: "end_meeting",
              value: meetingId,
              style: "danger"
            }
          ]
        }
      ]
    });

  } catch (error) {
    console.error('Error starting meeting:', error);
    await respond('❌ Error starting meeting. Please try again.');
  }
});

// Handle check-in button clicks
app.action('checkin', async ({ body, ack, client }) => {
  await ack();

  const meetingId = body.actions[0].value;
  const userId = body.user.id;
  const meeting = activeMeetings.get(meetingId);

  if (!meeting) {
    await client.chat.update({
      channel: body.channel.id,
      ts: body.message.ts,
      text: "❌ This meeting has ended or is no longer valid."
    });
    return;
  }

  // Check if already checked in
  if (meeting.attendees.has(userId)) {
    await client.chat.update({
      channel: body.channel.id,
      ts: body.message.ts,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `✅ *Already Checked In!*\n\nYou're already marked present for **${meeting.meetingName}**.`
          }
        }
      ]
    });
    return;
  }

  // Verify user is still in proximity (re-check location)
  try {
    const userLocation = await getUserLocation(userId);
    const distance = calculateDistance(
      meeting.location.lat,
      meeting.location.lng,
      userLocation.lat,
      userLocation.lng
    );

    if (distance <= meeting.radius) {
      // Add to attendance with timestamp
      meeting.attendees.set(userId, new Date());
      
      // Get user info for confirmation
      const userInfo = await client.users.info({ user: userId });
      const userName = userInfo.user.real_name || userInfo.user.name;
      
      // Update the check-in message to show success
      await client.chat.update({
        channel: body.channel.id,
        ts: body.message.ts,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `✅ *Checked In Successfully!*\n\nHi ${userName}! You've been marked present for **${meeting.meetingName}**.\n\n⏰ *Check-in time:* ${new Date().toLocaleTimeString()}`
            }
          }
        ]
      });

      // Notify meeting initiator
      await client.chat.postMessage({
        channel: meeting.initiatorId,
        text: `📋 **${userName}** just checked in to "${meeting.meetingName}" (${meeting.attendees.size} total attendees)`
      });

    } else {
      await client.chat.update({
        channel: body.channel.id,
        ts: body.message.ts,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `❌ *Not in Range*\n\nYou're no longer close enough to the meeting location. Please move within 150 meters and try again.`
            }
          }
        ]
      });
    }
  } catch (error) {
    console.error('Error during check-in:', error);
    await client.chat.update({
      channel: body.channel.id,
      ts: body.message.ts,
      text: "❌ Error verifying your location. Please try again."
    });
  }
});

// Handle view attendance button
app.action('view_attendance', async ({ body, ack, client }) => {
  await ack();

  const meetingId = body.actions[0].value;
  const userId = body.user.id;
  const meeting = activeMeetings.get(meetingId);

  if (!meeting) {
    await client.chat.postEphemeral({
      channel: body.channel.id,
      user: userId,
      text: "❌ Meeting not found or has ended."
    });
    return;
  }

  if (meeting.initiatorId !== userId) {
    await client.chat.postEphemeral({
      channel: body.channel.id,
      user: userId,
      text: "❌ Only the meeting initiator can view attendance details."
    });
    return;
  }

  // Get attendee details
  const attendeeDetails = await Promise.all(
    Array.from(meeting.attendees.keys()).map(async (attendeeId) => {
      try {
        const userInfo = await client.users.info({ user: attendeeId });
        const checkInTime = meeting.attendees.get(attendeeId);
        return {
          name: userInfo.user.real_name || userInfo.user.name,
          username: userInfo.user.name,
          checkInTime: checkInTime.toLocaleTimeString()
        };
      } catch (error) {
        return {
          name: 'Unknown User',
          username: 'unknown',
          checkInTime: 'Unknown'
        };
      }
    })
  );

  const duration = Math.round((Date.now() - meeting.startTime.getTime()) / 60000);
  
  let attendeeList = '';
  if (attendeeDetails.length > 0) {
    attendeeList = attendeeDetails
      .map(a => `• ${a.name} (@${a.username}) - ${a.checkInTime}`)
      .join('\n');
  } else {
    attendeeList = '_No check-ins yet_';
  }

  await client.chat.postEphemeral({
    channel: body.channel.id,
    user: userId,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `📊 *Live Attendance: ${meeting.meetingName}*\n\n⏱️ **Duration:** ${duration} minutes\n👥 **Checked In:** ${meeting.attendees.size} people\n\n**Attendee List:**\n${attendeeList}`
        }
      }
    ]
  });
});

// Handle end meeting button
app.action('end_meeting', async ({ body, ack, client }) => {
  await ack();

  const meetingId = body.actions[0].value;
  const userId = body.user.id;
  const meeting = activeMeetings.get(meetingId);

  if (!meeting) {
    await client.chat.postEphemeral({
      channel: body.channel.id,
      user: userId,
      text: "❌ Meeting not found or already ended."
    });
    return;
  }

  if (meeting.initiatorId !== userId) {
    await client.chat.postEphemeral({
      channel: body.channel.id,
      user: userId,
      text: "❌ Only the meeting initiator can end the meeting."
    });
    return;
  }

  // Get final attendance report
  const attendeeDetails = await Promise.all(
    Array.from(meeting.attendees.keys()).map(async (attendeeId) => {
      try {
        const userInfo = await client.users.info({ user: attendeeId });
        const checkInTime = meeting.attendees.get(attendeeId);
        return {
          name: userInfo.user.real_name || userInfo.user.name,
          username: userInfo.user.name,
          checkInTime: checkInTime.toLocaleTimeString()
        };
      } catch (error) {
        return { name: 'Unknown User', username: 'unknown', checkInTime: 'Unknown' };
      }
    })
  );

  const duration = Math.round((Date.now() - meeting.startTime.getTime()) / 60000);
  const endTime = new Date().toLocaleTimeString();
  
  let attendeeList = '';
  if (attendeeDetails.length > 0) {
    attendeeList = attendeeDetails
      .map(a => `• ${a.name} (@${a.username}) - ${a.checkInTime}`)
      .join('\n');
  } else {
    attendeeList = '_No one checked in_';
  }

  // Update the original message with final report
  await client.chat.update({
    channel: body.channel.id,
    ts: body.message.ts,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🔴 *Meeting Ended: ${meeting.meetingName}*\n\n⏰ **Started:** ${meeting.startTime.toLocaleTimeString()}\n⏰ **Ended:** ${endTime}\n⏱️ **Duration:** ${duration} minutes\n👥 **Total Attendees:** ${meeting.attendees.size}\n\n**Final Attendance:**\n${attendeeList}\n\n_Meeting ID: ${meetingId}_`
        }
      }
    ]
  });

  // Send summary DM to initiator
  await client.chat.postMessage({
    channel: meeting.initiatorId,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `📋 *Meeting Summary: ${meeting.meetingName}*\n\n**Duration:** ${duration} minutes\n**Attendees:** ${meeting.attendees.size} people\n\nAttendance has been posted in the channel.`
        }
      }
    ]
  });

  // Remove from active meetings
  activeMeetings.delete(meetingId);
});

// Help command
app.command('/attendance-help', async ({ command, ack, respond }) => {
  await ack();
  
  await respond({
    text: "Proximity Attendance Bot Help",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🤖 *Proximity Attendance Bot*\n\n**How to use:**\n• \`/start-meeting [name]\` - Start attendance tracking\n• Only people within 150 meters get check-in notifications\n• Use "View Attendance" to see live check-ins\n• Use "End Meeting" to close and show final results\n\n**Example:**\n\`/start-meeting Weekly Chapter Meeting\``
        }
      }
    ]
  });
});

// Error handling
app.error((error) => {
  console.error('Slack app error:', error);
});

// Start the app
(async () => {
  try {
    await app.start();
    console.log('⚡️ Proximity Attendance Bot is running!');
  } catch (error) {
    console.error('Failed to start app:', error);
  }
})();
