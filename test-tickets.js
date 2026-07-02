#!/usr/bin/env node

import axios from 'axios';

async function getApplications() {
  try {
    const res = await axios.post('http://localhost:3000/mcp', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'teamdynamix_list_applications',
        arguments: {
          response_format: 'json'
        }
      }
    }, {
      headers: {
        'Accept': 'application/json, text/event-stream',
        'Content-Type': 'application/json'
      }
    });

    const content = res.data.result.content[0];
    const data = JSON.parse(content.text);
    
    // data is an array directly when response_format is json
    const apps = Array.isArray(data) ? data : data.Applications;
    console.log('Available applications:');
    apps.forEach(app => {
      console.log(`  - ${app.Name} (ID: ${app.AppID})`);
    });
    
    const appId = apps[0].AppID;
    console.log(`\nUsing app_id: ${appId}\n`);
    return appId;
  } catch (error) {
    console.error('Error getting applications:', error.message);
    console.error(error);
    throw error;
  }
}

async function searchTickets(appId) {
  try {
    const res = await axios.post('http://localhost:3000/mcp', {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'teamdynamix_search_tickets',
        arguments: {
          app_id: appId,
          limit: 5,
          response_format: 'json'
        }
      }
    }, {
      headers: {
        'Accept': 'application/json, text/event-stream',
        'Content-Type': 'application/json'
      }
    });

    const content = res.data.result.content[0];
    
    // Try to parse as JSON first
    let ticketData;
    try {
      ticketData = JSON.parse(content.text);
    } catch (e) {
      // It might be an error response in text format
      console.error('Response text:', content.text);
      throw new Error('Failed to parse response as JSON: ' + e.message);
    }
    
    const tickets = Array.isArray(ticketData) ? ticketData : (ticketData?.items || ticketData?.Tickets || []);
    
    console.log('📋 5 Most Recent Tickets:\n');
    if (tickets && tickets.length > 0) {
      tickets.forEach((ticket, i) => {
        console.log(`${i + 1}. Ticket #${ticket.ID} - ${ticket.Title}`);
        console.log(`   Status: ${ticket.StatusName}`);
        console.log(`   Priority: ${ticket.PriorityName || 'N/A'}`);
        console.log(`   Created: ${ticket.CreatedDate || 'N/A'}`);
        console.log();
      });
    } else {
      console.log('No tickets found.');
      console.log('Response data structure:', Object.keys(ticketData || {}));
      if (ticketData && typeof ticketData === 'object') {
        console.log('Full ticketData:', JSON.stringify(ticketData).substring(0, 200));
      }
    }
  } catch (error) {
    console.error('Error searching tickets:', error.message);
    if (error.response?.data) {
      console.error('Response:', error.response.data);
    }
  }
}

async function main() {
  try {
    await getApplications();
    
    // Use app_id 671 (Admissions and Recruitment Administrative Services) which has tickets
    console.log('Searching in "Admissions and Recruitment Administrative Services" (app_id: 671)...\n');
    await searchTickets(671);
  } catch (error) {
    // Error already logged
  }
}

main();
