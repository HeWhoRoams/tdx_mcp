#!/usr/bin/env node

import axios from 'axios';

async function testTicketSearch() {
  try {
    const baseUrl = 'https://cmich.teamdynamix.com/TDWebApi/api';
    
    // First, get a token
    const authRes = await axios.post(`${baseUrl}/auth/loginadmin`, {
      BEID: '235B0D9F-A302-4F2F-AECE-960F149DB112',
      WebServicesKey: '84F94A77-1C3A-464E-B6FB-77218FFA4CC7'
    });
    const token = authRes.data.trim();
    
    console.log('✅ Authenticated\n');
    
    // Try app_id 671 (Admissions and Recruitment Administrative Services)
    console.log('Testing ticket search for app_id=671...');
    const searchRes = await axios.post(
      `${baseUrl}/671/tickets/search`,
      { MaxResults: 5 },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log('✅ Search successful!');
    console.log(`Found ${searchRes.data.length} tickets`);
    if (searchRes.data.length > 0) {
      console.log('\nFirst 5 tickets:');
      searchRes.data.slice(0, 5).forEach((ticket, i) => {
        console.log(`${i + 1}. #${ticket.ID} - ${ticket.Title} [${ticket.StatusName}]`);
      });
    }
    
  } catch (error) {
    console.error('❌ Error:', error.response?.status, error.response?.data || error.message);
  }
}

testTicketSearch();
